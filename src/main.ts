/*
 * Created with @iobroker/create-adapter v3.1.2
 *
 * This code is adapted from https://github.com/ioBroker/ioBroker.influxdb
 * Mostly:
 *  - Instrumentation logic
 *  - UI layout stuff
 *  - Persistence, custom state logic
 *
 * ########################################
 * Copyright Notice of ioBroker.influxdb
 * ========================================
 *
 * The MIT License (MIT)
 * Copyright (c) 2015-2025 bluefox, apollon77
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 * ########################################
 */

import { Semaphore } from 'await-semaphore';
import type { Gauge, Meter as IMeter } from '@opentelemetry/api';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { OTLPMetricExporterOptions } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPHttpExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPGrpcExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import type { Resource } from '@opentelemetry/resources';
import { resourceFromAttributes, emptyResource } from '@opentelemetry/resources';

import * as utils from '@iobroker/adapter-core';
import type { OtlpAdapterConfig, OtlpCustomConfig, OtlpCustomConfigTyped } from './types';

function isNullOrUndefined(obj?: any): obj is null {
    return obj === undefined || obj === null;
}

function parseNumberWithNull(value: any): number | null {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        const v = parseFloat(value);
        return isNaN(v) ? null : v;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    return null;
}

function iobTable2Record(attributesFromConfig: { key: string; value: string }[] | undefined): Record<string, string> {
    if (!attributesFromConfig) {
        return {};
    }

    return attributesFromConfig.reduce((prev, tuple) => ({ ...prev, [tuple.key]: tuple.value }), {});
}

interface SavedOtlpCustomConfig extends OtlpCustomConfigTyped {
    config: string;
    realId: string;
    state: ioBroker.State | null | undefined;
    skipped: ioBroker.State | null | undefined;
    lastLogTime?: number;
}

class Otlp extends utils.Adapter {
    declare config: OtlpAdapterConfig;

    private _subscribeAll = false;

    private _resource: Resource | null = null;
    private _meterProvider: MeterProvider | null = null;
    private _meter: IMeter | null = null;

    private _connected: boolean = false;

    private readonly setValuesInterval: number = 1000 * 60;
    private setValuesTimer: NodeJS.Timeout | null = null;

    // Mapping from AliasID to ioBroker ID
    private readonly _trackedDataPoints: {
        [ioBrokerId: string]: SavedOtlpCustomConfig;
    } = {};

    private readonly _instrumentLookup: Record<string, Gauge> = {};

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'otlp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private _protocol: string = '';
    private _otlProtocol: string = '';
    private _host: string = '';
    private _port: string | number = '';

    private async onReady(): Promise<void> {
        this.setConnected(false);

        const { protocol, otlProtocol, host, port } = this.config;

        if (
            isNullOrUndefined(protocol) ||
            isNullOrUndefined(otlProtocol) ||
            isNullOrUndefined(host) ||
            isNullOrUndefined(port)
        ) {
            this.log.error(
                'At least one required property was not set. Cannot start. Please adjust the configuration.',
            );

            return;
        }
        this._protocol = protocol;
        this._otlProtocol = otlProtocol;
        this._host = host;
        this._port = port;

        const { resourceAttributes } = this.config;

        const connectionValid = await this.testConnectionAsync();
        this.setConnected(connectionValid);

        if (!connectionValid) {
            this.log.info('Provided connection info is invalid. Please adjust the configuration.');
            return;
        }

        const { exporter: metricExporter } = this.createEndpointAndExporter();

        if (isNullOrUndefined(metricExporter)) {
            return;
        }

        this._resource =
            !!resourceAttributes && Object.keys(resourceAttributes).length > 0
                ? resourceFromAttributes(iobTable2Record(resourceAttributes))
                : emptyResource();

        await this.loadCustomEntitiesAsync();

        this.createMeter(metricExporter);
        this.createMetricInstruments();

        this.subscribeToStates();
        this.subscribeForeignObjects('*');

        this.setValuesTimer = setInterval(this.periodicallySetValues.bind(this), this.setValuesInterval);
    }

    private createMeter(metricExporter: PushMetricExporter): void {
        this._meterProvider = new MeterProvider({
            readers: [
                new PeriodicExportingMetricReader({
                    exporter: metricExporter,
                    exportIntervalMillis: 1000,
                }),
            ],
            resource: this._resource ?? emptyResource(),
        });

        const { meterName } = this.config;

        this._meter = this._meterProvider.getMeter(meterName ?? this.namespace, undefined, {});
    }

    private testConnectionAsync(): Promise<boolean> {
        const { endpoint: otlpEndpoint, exporter: metricExporter } = this.createEndpointAndExporter();

        if (!otlpEndpoint || !metricExporter) {
            this.log.error('Could not create metric exporter. Cannot continue. Stopping.');
            return Promise.resolve(false);
        }

        this.log.info(`Connecting to OTLP endpoint: ${otlpEndpoint}`);

        const testPayload: ResourceMetrics = {
            resource: emptyResource(),
            scopeMetrics: [],
        };

        return new Promise((resolve, _) => {
            metricExporter.export(testPayload, async result => {
                await metricExporter.shutdown();

                if (result.error === undefined) {
                    resolve(true);
                    return;
                }

                this.log.warn(
                    `An error occurred trying to connect to the provided open telemetry gateway: ${result.error.message}`,
                );

                if (result.error.stack !== undefined && result.error.stack.length > 0) {
                    this.log.debug(result.error.stack);
                }

                resolve(false);
            });
        });
    }

    private subscribeToStates(): void {
        // If we have less than 20 data points, subscribe individually, else subscribe to all
        if (Object.keys(this._trackedDataPoints).length < 20) {
            this.log.info(`subscribing to ${Object.keys(this._trackedDataPoints).length} data points`);
            for (const _id in this._trackedDataPoints) {
                if (Object.prototype.hasOwnProperty.call(this._trackedDataPoints, _id)) {
                    this.subscribeForeignStates(this._trackedDataPoints[_id].realId);
                }
            }
        } else {
            this.log.debug(
                `subscribing to all data points as we have ${Object.keys(this._trackedDataPoints).length} data points to log`,
            );
            this._subscribeAll = true;
            this.subscribeForeignStates('*');
        }
    }

    private async loadCustomEntitiesAsync(): Promise<void> {
        const doc = await this.getObjectViewAsync('system', 'custom', {});

        if (!doc || !doc.rows || doc.rows.length == 0) {
            return;
        }

        const filteredRows = doc.rows.filter(row => !!row.value).filter(row => row.value[this.namespace]?.enabled);

        for (const row of filteredRows) {
            const item: {
                id: string;
                value: {
                    [key: `${string}.${number}`]: OtlpCustomConfigTyped;
                };
            } = row;

            const id = item.id;
            const realId = id;

            this._trackedDataPoints[id] = item.value[this.namespace] as SavedOtlpCustomConfig;

            this._trackedDataPoints[id].config = JSON.stringify(item.value[this.namespace]);
            this.log.debug(`Enabled logging of ${id}, Alias=${id !== realId} points now activated`);

            this._trackedDataPoints[id].realId = realId;
        }
    }

    private createMetricInstruments(): void {
        this.log.info(`Creating instruments for ${Object.keys(this._trackedDataPoints).length} data points.`);

        for (const trackedDataPointKey of Object.keys(this._trackedDataPoints)) {
            this.createInstrumentForDataPointKey(trackedDataPointKey);
        }
    }

    private getInstrumentIdentifier(dataPoint: SavedOtlpCustomConfig): string {
        const { aliasId, realId } = dataPoint;
        return isNullOrUndefined(aliasId) || aliasId.trim() === '' ? realId : aliasId;
    }

    private createInstrumentForDataPointKey(trackedDataPointKey: string): void {
        if (!Object.prototype.hasOwnProperty.call(this._trackedDataPoints, trackedDataPointKey)) {
            this.log.warn(
                `Expected instrument '${trackedDataPointKey}' to be present in data points, but it was not. Skipping.`,
            );
            return;
        }

        const trackedDataPoint = this._trackedDataPoints[trackedDataPointKey];
        const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);

        if (isNullOrUndefined(this._meter)) {
            this.log.error('No meter instance was created. This should never happen.');
            return;
        }

        this.log.debug(`Creating gauge with name: '${instrumentIdentifier}' (key=${trackedDataPointKey})`);
        this._instrumentLookup[trackedDataPointKey] = this._meter.createGauge(instrumentIdentifier);
    }

    private async onUnload(callback: () => void): Promise<void> {
        try {
            this.log.info('Shutting down open telemetry SDK.');

            if (!isNullOrUndefined(this._meterProvider)) {
                await this._meterProvider.forceFlush();
                await this._meterProvider.shutdown();
            }

            if (this.setValuesTimer) {
                clearInterval(this.setValuesTimer);
            }

            this.setConnected(false);
        } finally {
            callback();
        }
    }

    private isTrackedDataPoint(object: unknown): object is OtlpCustomConfig {
        if (object === null || object === undefined) {
            return false;
        }

        return (
            Object.prototype.hasOwnProperty.call(object, 'aliasId') &&
            Object.prototype.hasOwnProperty.call(object, 'enabled')
        );
    }

    private async onObjectChange(id: string, obj: ioBroker.Object | null | undefined): Promise<void> {
        if (isNullOrUndefined(obj?.common?.custom?.[this.namespace])) {
            return;
        }

        const customConfig = obj.common.custom[this.namespace];

        if (!this.isTrackedDataPoint(customConfig)) {
            return;
        }

        customConfig.enabled ? this.addTrackedDataPoint(id, customConfig) : this.removeTrackedDataPoint(id);

        const startMs = performance.now();
        await this._meterProvider?.forceFlush();
        await this._meterProvider?.shutdown();
        this._meterProvider = null;

        const { exporter: nextExporter } = this.createEndpointAndExporter();

        if (isNullOrUndefined(nextExporter)) {
            return;
        }

        // There is no way to destroy an existing meter (which is valid, because that's usually not how otel works).
        // Instead, we need to stop the entire SDK and recreate the meters.
        // This is quite efficient, so it's not an issue.

        this.createMeter(nextExporter);
        this.createMetricInstruments();

        const duration = performance.now() - startMs;
        this.log.debug(`Recreated SDK and meters in ${duration}ms.`);

        if (!customConfig.enabled) {
            return;
        }

        await this.retrieveAndRecordValueAsync(id);
    }

    private addTrackedDataPoint(id: string, customConfig: OtlpCustomConfig): void {
        // if not yet subscribed
        if (!this._trackedDataPoints[id] && !this._subscribeAll) {
            if (Object.keys(this._trackedDataPoints).length >= 19) {
                // unsubscribe all subscriptions and subscribe to all
                for (const _id in this._trackedDataPoints) {
                    this.unsubscribeForeignStates(this._trackedDataPoints[_id].realId);
                }
                this._subscribeAll = true;
                this.subscribeForeignStates('*');
            } else {
                this.subscribeForeignStates(id);
            }
        }

        const customSettings: OtlpCustomConfig = customConfig;

        const state = this._trackedDataPoints[id] ? this._trackedDataPoints[id].state : null;
        const skipped = this._trackedDataPoints[id] ? this._trackedDataPoints[id].skipped : null;

        this._trackedDataPoints[id] = customSettings as SavedOtlpCustomConfig;
        this._trackedDataPoints[id].config = JSON.stringify(customSettings);
        this._trackedDataPoints[id].realId = id;
        this._trackedDataPoints[id].state = state;
        this._trackedDataPoints[id].skipped = skipped;

        this.log.info(`enabled logging of ${id}, Alias=${!!customSettings.aliasId}`);
    }

    private removeTrackedDataPoint(id: string): void {
        if (!this._trackedDataPoints[id]) {
            return;
        }

        delete this._trackedDataPoints[id];
        this.log.info(`disabled logging of ${id}`);

        if (!this._subscribeAll) {
            this.unsubscribeForeignStates(id);
        }
    }

    async retrieveAndRecordValueAsync(id: string): Promise<void> {
        const state = await this.getForeignStateAsync(id);

        if (!state || !this._trackedDataPoints[id]) {
            return;
        }

        state.from = `system.adapter.${this.namespace}`;
        this._trackedDataPoints[id].state = state;

        this.recordStateByIobId(id, state);
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state) {
            return;
        }

        if (isNullOrUndefined(this._trackedDataPoints[id])) {
            return;
        }

        this.recordStateByIobId(id, state);
    }

    private async periodicallySetValues(): Promise<void> {
        const numDataPoints = Object.keys(this._trackedDataPoints).length;

        if (!this._meter || numDataPoints === 0) {
            this.log.debug('No meter or tracked data points available, skipping periodic value update.');
            return;
        }

        const startMs = performance.now();

        this.log.debug(`Timer: Updating values for ${numDataPoints} tracked data points.`);

        const semaphore = new Semaphore(8);

        const allPromises = Object.keys(this._trackedDataPoints).map(async dPointId => {
            let release: (() => void) | null = null;

            try {
                release = await semaphore.acquire();
                await this.retrieveAndRecordValueAsync(dPointId);
                return true;
            } catch (e) {
                this.log.error(
                    `Unexpected error in worker execution for data point ${dPointId}: ${e instanceof Error ? e.message : JSON.stringify(e)}`,
                );
                return false;
            } finally {
                release?.call(release);
            }
        });

        const allResults = await Promise.all(allPromises);

        const successfulUpdates = allResults.filter(result => result).length;
        const duration = performance.now() - startMs;

        this.log.debug(
            `Timer: Updated values for ${successfulUpdates}/${numDataPoints} tracked data points in ${duration}ms.`,
        );
    }

    createEndpointAndExporter(): { endpoint: string | null; exporter: PushMetricExporter | null } {
        let otlpEndpoint: string | null = null;
        let metricExporter: PushMetricExporter | null = null;

        const { headers } = this.config;
        const headerRecord = iobTable2Record(headers);

        this.log.debug(`There are ${Object.keys(headers).length} header kvps to append.`);

        if (this._otlProtocol === 'http') {
            otlpEndpoint = `${this._protocol}://${this._host}:${this._port}/v1/metrics`;

            const collectorOptions: OTLPMetricExporterOptions = {
                url: otlpEndpoint,
                headers: headerRecord,
            };
            metricExporter = new OTLPHttpExporter(collectorOptions);
        }

        if (this._otlProtocol === 'grpc') {
            otlpEndpoint = `${this._protocol}://${this._host}:${this._port}/otlp`;

            const collectorOptions: OTLPMetricExporterOptions = {
                url: otlpEndpoint,
                headers: headerRecord,
            };
            metricExporter = new OTLPGrpcExporter(collectorOptions);
        }

        return { endpoint: otlpEndpoint, exporter: metricExporter };
    }

    private recordStateByIobId(id: string, state: ioBroker.State): void {
        if (!Object.prototype.hasOwnProperty.call(this._trackedDataPoints, id)) {
            this.log.warn(`Expected id=${id} to have a valid data point configuration, but it does not. Skipping.`);
            return;
        }

        if (!Object.prototype.hasOwnProperty.call(this._instrumentLookup, id)) {
            this.log.warn(`Expected id=${id} to have a valid instrument, but it does not. Skipping.`);
            return;
        }

        const dataPointCfg = this._trackedDataPoints[id];
        const instrument = this._instrumentLookup[id];
        this.log.debug(`Received state change for tracked data point: ${id}. Persisting.`);

        const otlpValue = this.transformStateValue(state.val);
        this.log.debug(`Determined value to write: '${otlpValue}'.`);

        if (isNullOrUndefined(otlpValue)) {
            return;
        }

        instrument.record(otlpValue, iobTable2Record(dataPointCfg?.attributes));
    }

    private transformStateValue(iobValue: ioBroker.StateValue): number | null {
        return parseNumberWithNull(iobValue);
    }

    private setConnected(isConnected: boolean): void {
        if (this._connected !== isConnected) {
            this._connected = isConnected;
            void this.setState('info.connection', this._connected, true, error =>
                // analyse if the state could be set (because of permissions)
                error
                    ? this.log.error(`Can not update this._connected state: ${error}`)
                    : this.log.debug(`connected set to ${this._connected}`),
            );
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Otlp(options);
} else {
    // otherwise start the instance directly
    (() => new Otlp())();
}
