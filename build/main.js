"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_await_semaphore = require("await-semaphore");
var import_sdk_metrics = require("@opentelemetry/sdk-metrics");
var import_exporter_metrics_otlp_http = require("@opentelemetry/exporter-metrics-otlp-http");
var import_exporter_metrics_otlp_grpc = require("@opentelemetry/exporter-metrics-otlp-grpc");
var import_resources = require("@opentelemetry/resources");
var utils = __toESM(require("@iobroker/adapter-core"));
function isNullOrUndefined(obj) {
  return obj === void 0 || obj === null;
}
function parseNumberWithNull(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const v = parseFloat(value);
    return isNaN(v) ? null : v;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return null;
}
function iobTable2Record(attributesFromConfig) {
  if (!attributesFromConfig) {
    return {};
  }
  return attributesFromConfig.reduce((prev, tuple) => ({ ...prev, [tuple.key]: tuple.value }), {});
}
class Otlp extends utils.Adapter {
  _subscribeAll = false;
  _resource = null;
  _meterProvider = null;
  _meter = null;
  _connected = false;
  setValuesInterval = 1e3 * 60;
  setValuesTimer = null;
  // Mapping from AliasID to ioBroker ID
  _trackedDataPoints = {};
  _instrumentLookup = {};
  constructor(options = {}) {
    super({
      ...options,
      name: "otlp"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  _protocol = "";
  _otlProtocol = "";
  _host = "";
  _port = "";
  async onReady() {
    this.setConnected(false);
    const { protocol, otlProtocol, host, port } = this.config;
    if (isNullOrUndefined(protocol) || isNullOrUndefined(otlProtocol) || isNullOrUndefined(host) || isNullOrUndefined(port)) {
      this.log.error(
        "At least one required property was not set. Cannot start. Please adjust the configuration."
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
      this.log.info("Provided connection info is invalid. Please adjust the configuration.");
      return;
    }
    const { exporter: metricExporter } = this.createEndpointAndExporter();
    if (isNullOrUndefined(metricExporter)) {
      return;
    }
    this._resource = !!resourceAttributes && Object.keys(resourceAttributes).length > 0 ? (0, import_resources.resourceFromAttributes)(iobTable2Record(resourceAttributes)) : (0, import_resources.emptyResource)();
    await this.loadCustomEntitiesAsync();
    this.createMeter(metricExporter);
    this.createMetricInstruments();
    this.subscribeToStates();
    this.subscribeForeignObjects("*");
    this.setValuesTimer = setInterval(this.periodicallySetValues.bind(this), this.setValuesInterval);
  }
  createMeter(metricExporter) {
    var _a;
    this._meterProvider = new import_sdk_metrics.MeterProvider({
      readers: [
        new import_sdk_metrics.PeriodicExportingMetricReader({
          exporter: metricExporter,
          exportIntervalMillis: 1e3
        })
      ],
      resource: (_a = this._resource) != null ? _a : (0, import_resources.emptyResource)()
    });
    const { meterName } = this.config;
    this._meter = this._meterProvider.getMeter(meterName != null ? meterName : this.namespace, void 0, {});
  }
  testConnectionAsync() {
    const { endpoint: otlpEndpoint, exporter: metricExporter } = this.createEndpointAndExporter();
    if (!otlpEndpoint || !metricExporter) {
      this.log.error("Could not create metric exporter. Cannot continue. Stopping.");
      return Promise.resolve(false);
    }
    this.log.info(`Connecting to OTLP endpoint: ${otlpEndpoint}`);
    const testPayload = {
      resource: (0, import_resources.emptyResource)(),
      scopeMetrics: []
    };
    return new Promise((resolve, _) => {
      metricExporter.export(testPayload, async (result) => {
        await metricExporter.shutdown();
        if (result.error === void 0) {
          resolve(true);
          return;
        }
        this.log.warn(
          `An error occurred trying to connect to the provided open telemetry gateway: ${result.error.message}`
        );
        if (result.error.stack !== void 0 && result.error.stack.length > 0) {
          this.log.debug(result.error.stack);
        }
        resolve(false);
      });
    });
  }
  subscribeToStates() {
    if (Object.keys(this._trackedDataPoints).length < 20) {
      this.log.info(`subscribing to ${Object.keys(this._trackedDataPoints).length} data points`);
      for (const _id in this._trackedDataPoints) {
        if (Object.prototype.hasOwnProperty.call(this._trackedDataPoints, _id)) {
          this.subscribeForeignStates(this._trackedDataPoints[_id].realId);
        }
      }
    } else {
      this.log.debug(
        `subscribing to all data points as we have ${Object.keys(this._trackedDataPoints).length} data points to log`
      );
      this._subscribeAll = true;
      this.subscribeForeignStates("*");
    }
  }
  async loadCustomEntitiesAsync() {
    const doc = await this.getObjectViewAsync("system", "custom", {});
    if (!doc || !doc.rows || doc.rows.length == 0) {
      return;
    }
    const filteredRows = doc.rows.filter((row) => !!row.value).filter((row) => {
      var _a;
      return (_a = row.value[this.namespace]) == null ? void 0 : _a.enabled;
    });
    for (const row of filteredRows) {
      const item = row;
      const id = item.id;
      const realId = id;
      this._trackedDataPoints[id] = item.value[this.namespace];
      this._trackedDataPoints[id].config = JSON.stringify(item.value[this.namespace]);
      this.log.debug(`Enabled logging of ${id}, Alias=${id !== realId} points now activated`);
      this._trackedDataPoints[id].realId = realId;
    }
  }
  createMetricInstruments() {
    this.log.info(`Creating instruments for ${Object.keys(this._trackedDataPoints).length} data points.`);
    for (const trackedDataPointKey of Object.keys(this._trackedDataPoints)) {
      this.createInstrumentForDataPointKey(trackedDataPointKey);
    }
  }
  getInstrumentIdentifier(dataPoint) {
    const { aliasId, realId } = dataPoint;
    return isNullOrUndefined(aliasId) || aliasId.trim() === "" ? realId : aliasId;
  }
  createInstrumentForDataPointKey(trackedDataPointKey) {
    if (!Object.prototype.hasOwnProperty.call(this._trackedDataPoints, trackedDataPointKey)) {
      this.log.warn(
        `Expected instrument '${trackedDataPointKey}' to be present in data points, but it was not. Skipping.`
      );
      return;
    }
    const trackedDataPoint = this._trackedDataPoints[trackedDataPointKey];
    const instrumentIdentifier = this.getInstrumentIdentifier(trackedDataPoint);
    if (isNullOrUndefined(this._meter)) {
      this.log.error("No meter instance was created. This should never happen.");
      return;
    }
    this.log.debug(`Creating gauge with name: '${instrumentIdentifier}' (key=${trackedDataPointKey})`);
    this._instrumentLookup[trackedDataPointKey] = this._meter.createGauge(instrumentIdentifier);
  }
  async onUnload(callback) {
    try {
      this.log.info("Shutting down open telemetry SDK.");
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
  isTrackedDataPoint(object) {
    if (object === null || object === void 0) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(object, "aliasId") && Object.prototype.hasOwnProperty.call(object, "enabled");
  }
  async onObjectChange(id, obj) {
    var _a, _b, _c, _d;
    if (isNullOrUndefined((_b = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.custom) == null ? void 0 : _b[this.namespace])) {
      return;
    }
    const customConfig = obj.common.custom[this.namespace];
    if (!this.isTrackedDataPoint(customConfig)) {
      return;
    }
    customConfig.enabled ? this.addTrackedDataPoint(id, customConfig) : this.removeTrackedDataPoint(id);
    const startMs = performance.now();
    await ((_c = this._meterProvider) == null ? void 0 : _c.forceFlush());
    await ((_d = this._meterProvider) == null ? void 0 : _d.shutdown());
    this._meterProvider = null;
    const { exporter: nextExporter } = this.createEndpointAndExporter();
    if (isNullOrUndefined(nextExporter)) {
      return;
    }
    this.createMeter(nextExporter);
    this.createMetricInstruments();
    const duration = performance.now() - startMs;
    this.log.debug(`Recreated SDK and meters in ${duration}ms.`);
    if (!customConfig.enabled) {
      return;
    }
    await this.writeInitialValueAsync(id);
  }
  addTrackedDataPoint(id, customConfig) {
    if (!this._trackedDataPoints[id] && !this._subscribeAll) {
      if (Object.keys(this._trackedDataPoints).length >= 19) {
        for (const _id in this._trackedDataPoints) {
          this.unsubscribeForeignStates(this._trackedDataPoints[_id].realId);
        }
        this._subscribeAll = true;
        this.subscribeForeignStates("*");
      } else {
        this.subscribeForeignStates(id);
      }
    }
    const customSettings = customConfig;
    const state = this._trackedDataPoints[id] ? this._trackedDataPoints[id].state : null;
    const skipped = this._trackedDataPoints[id] ? this._trackedDataPoints[id].skipped : null;
    this._trackedDataPoints[id] = customSettings;
    this._trackedDataPoints[id].config = JSON.stringify(customSettings);
    this._trackedDataPoints[id].realId = id;
    this._trackedDataPoints[id].state = state;
    this._trackedDataPoints[id].skipped = skipped;
    this.log.info(`enabled logging of ${id}, Alias=${!!customSettings.aliasId}`);
  }
  removeTrackedDataPoint(id) {
    if (!this._trackedDataPoints[id]) {
      return;
    }
    delete this._trackedDataPoints[id];
    this.log.info(`disabled logging of ${id}`);
    if (!this._subscribeAll) {
      this.unsubscribeForeignStates(id);
    }
  }
  async writeInitialValueAsync(id) {
    const state = await this.getForeignStateAsync(id);
    if (!state || !this._trackedDataPoints[id]) {
      return;
    }
    state.from = `system.adapter.${this.namespace}`;
    this._trackedDataPoints[id].state = state;
    this.recordStateByIobId(id, state);
  }
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    if (isNullOrUndefined(this._trackedDataPoints[id])) {
      return;
    }
    this.recordStateByIobId(id, state);
  }
  async periodicallySetValues() {
    const numDataPoints = Object.keys(this._trackedDataPoints).length;
    if (!this._meter || numDataPoints === 0) {
      this.log.debug("No meter or tracked data points available, skipping periodic value update.");
      return;
    }
    const startMs = performance.now();
    this.log.debug(`Timer: Updating values for ${numDataPoints} tracked data points.`);
    const semaphore = new import_await_semaphore.Semaphore(8);
    const allPromises = Object.keys(this._trackedDataPoints).map(async (dPointId) => {
      let release = null;
      try {
        release = await semaphore.acquire();
        await this.writeInitialValueAsync(dPointId);
        return true;
      } catch (e) {
        this.log.error(
          `Unexpected error in worker execution for data point ${dPointId}: ${e instanceof Error ? e.message : JSON.stringify(e)}`
        );
        return false;
      } finally {
        release == null ? void 0 : release.call(release);
      }
    });
    const allResults = await Promise.all(allPromises);
    const successfulUpdates = allResults.filter((result) => result).length;
    const duration = performance.now() - startMs;
    this.log.debug(
      `Timer: Updated values for ${successfulUpdates}/${numDataPoints} tracked data points in ${duration}ms.`
    );
  }
  createEndpointAndExporter() {
    let otlpEndpoint = null;
    let metricExporter = null;
    const { headers } = this.config;
    const headerRecord = iobTable2Record(headers);
    this.log.debug(`There are ${Object.keys(headers).length} header kvps to append.`);
    if (this._otlProtocol === "http") {
      otlpEndpoint = `${this._protocol}://${this._host}:${this._port}/v1/metrics`;
      const collectorOptions = {
        url: otlpEndpoint,
        headers: headerRecord
      };
      metricExporter = new import_exporter_metrics_otlp_http.OTLPMetricExporter(collectorOptions);
    }
    if (this._otlProtocol === "grpc") {
      otlpEndpoint = `${this._protocol}://${this._host}:${this._port}/otlp`;
      const collectorOptions = {
        url: otlpEndpoint,
        headers: headerRecord
      };
      metricExporter = new import_exporter_metrics_otlp_grpc.OTLPMetricExporter(collectorOptions);
    }
    return { endpoint: otlpEndpoint, exporter: metricExporter };
  }
  recordStateByIobId(id, state) {
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
    instrument.record(otlpValue, iobTable2Record(dataPointCfg == null ? void 0 : dataPointCfg.attributes));
  }
  transformStateValue(iobValue) {
    return parseNumberWithNull(iobValue);
  }
  setConnected(isConnected) {
    if (this._connected !== isConnected) {
      this._connected = isConnected;
      void this.setState(
        "info.connection",
        this._connected,
        true,
        (error) => (
          // analyse if the state could be set (because of permissions)
          error ? this.log.error(`Can not update this._connected state: ${error}`) : this.log.debug(`connected set to ${this._connected}`)
        )
      );
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Otlp(options);
} else {
  (() => new Otlp())();
}
//# sourceMappingURL=main.js.map
