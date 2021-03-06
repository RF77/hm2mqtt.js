#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const pjson = require('persist-json')('hm2mqtt');
const async = require('async');
const log = require('yalm');
const request = require('request');
const Mqtt = require('mqtt');
const xmlrpc = require('homematic-xmlrpc');
const binrpc = require('binrpc');
const discover = require('./discover.js');
const pkg = require('./package.json');
const config = require('./config.js');

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');

const rpcClient = {};
const rpcServer = {};
const values = {};
const changes = {};
let names = {};
const addresses = {};
function reverseNames() {
    Object.keys(names).forEach(address => {
        addresses[names[address]] = address;
    });
}

const devices = {};
log.debug('loading', 'paramsetDescriptions_' + fileName());
const paramsetDescriptions = pjson.load('paramsetDescriptions_' + fileName()) || {};
const getParamsetTimeout = {};
const paramsetQueue = {};
const lastEvent = {};

const programs = {};
const programNames = {};
const variables = {};
const variableNames = {};
const variableType = {
    2: 'BOOL',
    4: 'FLOAT',
    16: 'INTEGER',
    20: 'STRING'
};

let mqttConnected;

log.info('mqtt trying to connect', config.mqttUrl);

const mqtt = Mqtt.connect(config.mqttUrl, {
    clientId: config.name + '_' + Math.random().toString(16).substr(2, 8),
    will: {topic: config.name + '/connected', payload: '0', retain: true},
    username: config.mqttUsername,
    password: config.mqttPassword
});

mqtt.on('connect', () => {
    mqttConnected = true;

    log.info('mqtt connected', config.mqttUrl);
    mqtt.publish(config.name + '/connected', '1', {retain: true});

    log.info('mqtt subscribe', config.name + '/set/#');
    mqtt.subscribe(config.name + '/set/#');

    log.info('mqtt subscribe', config.name + '/rpc/#');
    mqtt.subscribe(config.name + '/rpc/#');

    log.info('mqtt subscribe', config.name + '/command/#');
    mqtt.subscribe(config.name + '/command/#');
});

mqtt.on('close', () => {
    if (mqttConnected) {
        mqttConnected = false;
        log.error('mqtt closed ' + config.mqttUrl);
    }
});

mqtt.on('error', err => {
    log.error('mqtt', err);
});

mqtt.on('close', () => {
    log.warn('mqtt close');
});

mqtt.on('offline', () => {
    log.warn('mqtt offline');
});

mqtt.on('reconnect', () => {
    log.info('mqtt reconnect');
});

function mqttPublish(topic, payload, options) {
    if (typeof payload === 'object') {
        payload = JSON.stringify(payload);
    } else if (payload) {
        payload = String(payload);
    } else {
        payload = '';
    }
    mqtt.publish(topic, payload, options, err => {
        if (err) {
            log.error('mqtt publish', err);
        } else {
            log.debug('mqtt >', topic, payload);
        }
    });
}

mqtt.on('message', (topic, payload) => {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);
    const parts = topic.split('/');
    if (parts.length === 4 && parts[1] === 'set') {
        // Topic <name>/set/<channel>/<datapoint>
        rpcSet(parts[2], 'VALUES', parts[3], payload);
    } else if (parts.length === 5 && parts[1] === 'set') {
        // Topic <name>/set/<channel>/<paramset>/<datapoint>
        // Todo Putparamset
        rpcSet(parts[2], parts[3], parts[4], payload);
    } else if (parts.length === 5 && parts[1] === 'rpc') {
        // Topic <name>/rpc/<interface>/<command>/<call_id> - Answer: <name>/response/<call_id>
        const [, , iface, command, callid] = parts;
        rpc(iface, command, callid, payload);
    } else if (parts.length === 3 && parts[1] === 'set') {
        if (variables[parts[2]]) {
            // Topic <name>/set/<variableName>
            setVar(variables[parts[2]], payload);
        } else if (programs[parts[2]]) {
            // Topic <name>/set/<programName>
            setProgram(programs[parts[2]], payload);
        } else {
            log.error('unknown variable/program', parts[2]);
        }
    } else if (parts[1] === 'command') {
        switch (parts[2]) {
            case 'regasync':
                getRegaDeviceNames();
                break;
            default:
                log.error('mqtt < unknown command', parts[2]);
        }
    } else {
        log.error('mqtt <', topic, payload);
    }
});

function setVar(variable, payload) {
    log.debug(variable, payload);
    let val;
    if (payload.indexOf('{') === 0) {
        try {
            val = JSON.parse(payload).val;
        } catch (err) {
            val = payload;
        }
    } else {
        val = payload;
    }

    switch (variable.type) {
        case 'BOOL':
            // OMG this is so ugly...
            if (val === 'false') {
                val = false;
            } else if (!isNaN(val)) { // Make sure that the string "0" gets casted to boolean false
                val = Number(val);
            }
            val = Boolean(val);
            break;
        case 'FLOAT':
            val = parseFloat(val) || 0;
            break;
        case 'INTEGER':
            if (typeof val === 'string') {
                if (variable.enum && (variable.enum.indexOf(val) !== -1)) {
                    val = variable.enum.indexOf(val);
                }
            }
            val = parseInt(val, 10) || 0;
            break;
        case 'STRING':
            val = '"' + String(val) + '"';
            break;
        default:
    }
    const script = 'dom.GetObject(' + variable.id + ').State(' + val + ');';
    log.debug(script);
    rega(script, err => {
        if (err) {
            log.error(err);
        }
    });
}

function setProgram(program, payload) {
    log.debug(program, payload);
    let val;
    let script;
    if (payload.indexOf('{') === 0) {
        try {
            val = JSON.parse(payload).val;
        } catch (err) {
            val = payload;
        }
    } else {
        val = payload;
    }
    if (val === 'start') {
        script = 'dom.GetObject(' + program.id + ').ProgramExecute();';
    } else {
        if (val === 'false') {
            val = false;
        }
        val = Boolean(val);
        script = 'dom.GetObject(' + program.id + ').Active(' + val + ');';
    }
    log.debug(script);
    rega(script, err => {
        if (err) {
            log.error(err);
        }
    });
}

function rpc(iface, command, callid, payload) {
    if (rpcClient[iface]) {
        let params;
        if (payload.indexOf('[') === 0) {
            try {
                params = JSON.parse(payload);
            } catch (err) {
                log.error(err);
            }
        } else if (params) {
            params = [params];
        } else {
            params = [];
        }
        log.debug('rpc', iface, '>', command, params);
        rpcClient[iface].methodCall(command, params, (err, res) => {
            if (err) {
                log.error(err);
            } else {
                const topic = config.name + '/response/' + callid;
                const payload = JSON.stringify(res);
                mqttPublish(topic, payload);
            }
        });
    }
}

function rpcType(payload, paramset) {
    let val;
    if (payload.indexOf('{') === 0) {
        try {
            val = JSON.parse(payload).val;
        } catch (err) {
            val = payload;
        }
    } else {
        val = payload;
    }

    switch (paramset.TYPE) {
        case 'BOOL':
        // eslint-disable-line no-fallthrough
        case 'ACTION':
            // OMG this is so ugly...
            if (val === 'false') {
                val = false;
            } else if (!isNaN(val)) { // Make sure that the string "0" gets casted to boolean false
                val = Number(val);
            }
            val = Boolean(val);
            break;
        case 'FLOAT':
            val = parseFloat(val);
            if (val < paramset.MIN) {
                val = paramset.MIN;
            } else if (val > paramset.MAX) {
                val = paramset.MAX;
            }
            val = {explicitDouble: val};
            break;
        case 'ENUM':
            if (typeof val === 'string') {
                if (paramset.ENUM && (paramset.ENUM.indexOf(val) !== -1)) {
                    val = paramset.ENUM.indexOf(val);
                }
            }
        // eslint-disable-line no-fallthrough
        case 'INTEGER':
            val = parseInt(val, 10);
            if (val < paramset.MIN) {
                val = paramset.MIN;
            } else if (val > paramset.MAX) {
                val = paramset.MAX;
            }
            break;
        case 'STRING':
            val = String(val);
            break;
        default:

    }

    return val;
}

function findIface(address) {
    let iface = null;
    Object.keys(devices).forEach(i => {
        if (devices[i] && devices[i][address]) {
            iface = i;
        }
    });
    return iface;
}

function rpcSet(name, paramset, datapoint, payload) {
    const address = addresses[name] || name;
    const iface = findIface(address);
    if (!iface) {
        log.error('unknown device', address);
        return;
    }
    const psName = paramsetName(devices[iface][address]);
    let ps = paramsetDescriptions[psName];
    ps = ps && ps[paramset] && ps[paramset][datapoint];
    if (!ps) {
        log.warn('unknown paramset', paramsetName(devices[iface][address]) + '.' + paramset + '.' + datapoint);
        return;
    }

    if (!(ps.OPERATIONS & 2)) {
        log.error(iface, address, paramset, datapoint, 'not writeable');
        return;
    }

    const val = rpcType(payload, ps);

    // Todo Putparamset
    log.debug('rpc', iface, '> setValue', [address, datapoint, val]);
    rpcClient[iface].methodCall('setValue', [address, datapoint, val], err => {
        if (err) {
            log.error(err);
        }
    });
}

function rega(script, callback) {
    const url = 'http://' + config.ccuAddress + ':8181/rega.exe';
    log.debug('sending script to', url);
    request({
        method: 'POST',
        url,
        body: script,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': script.length
        }
    }, (err, res, body) => {
        if (!err && body) {
            const end = body.indexOf('<xml>');
            const data = body.substr(0, end);
            callback(null, data);
        } else {
            callback(err);
        }
    });
}

function regaJson(file, callback) {
    const filepath = path.join(__dirname, 'regascripts', file);
    const script = fs.readFileSync(filepath).toString();
    rega(script, (err, res) => {
        if (err) {
            log.error(err);
        } else {
            try {
                callback(null, JSON.parse(unescape(res)));
            } catch (err) {
                callback(err);
            }
        }
    });
}

function getRegaDeviceNames(cb) {
    regaJson('devices.fn', (err, res) => {
        if (err) {
            log.error(err);
        } else {
            names = res;
            reverseNames();
            log.info('saving', 'names_' + fileName());
            pjson.save('names_' + fileName(), names);
            if (typeof cb === 'function') {
                cb();
            }
        }
    });
}

if (config.jsonNameTable) {
    log.info('loading name table', config.jsonNameTable);
    names = require(config.jsonNameTable);
    reverseNames();
} else if (!config.disableRega) {
    log.info('loading', 'names_' + fileName());
    names = pjson.load('names_' + fileName()) || {};
    getRegaDeviceNames(() => {
        if (config.regaPollInterval || config.regaPollTrigger) {
            getPrograms(() => {
                getVariables();
            });
        }
        if (config.regaPollInterval > 0) {
            log.debug('rega poll interval', config.regaPollInterval);
            setInterval(() => {
                getPrograms(() => {
                    getVariables();
                });
            }, config.regaPollInterval * 1000);
        }
    });
}

function getVariables() {
    regaJson('variables.fn', (err, res) => {
        if (err) {
            log.error(err);
        } else {
            Object.keys(res).forEach(id => {
                const varName = res[id].name;
                let change = false;
                if (!variables[varName] || (res[id].val !== variables[varName].val) || (res[id].ts !== variables[varName].ts)) {
                    change = true;
                }
                variables[varName] = {
                    id: Number(id),
                    val: res[id].val,
                    min: res[id].min,
                    max: res[id].max,
                    unit: res[id].unit,
                    ts: res[id].ts,
                    type: variableType[res[id].type],
                    enum: res[id].enum ? res[id].enum.split(';') : undefined
                };
                variableNames[Number(id)] = varName;
                if (change) {
                    const topic = config.name + '/status/' + varName;
                    let payload = {
                        val: res[id].val,
                        ts: res[id].ts,
                        hm: {
                            id: Number(id),
                            unit: res[id].unit,
                            min: res[id].min,
                            max: res[id].max
                        }
                    };
                    payload = JSON.stringify(payload);
                    mqttPublish(topic, payload, {retain: true});
                }
            });
            log.debug('rega got', Object.keys(variables).length, 'variables');
        }
    });
}

function getPrograms(cb) {
    regaJson('programs.fn', (err, res) => {
        if (err) {
            log.error(err);
            cb(err);
        } else {
            Object.keys(res).forEach(id => {
                const programName = res[id].name;
                let change = false;
                if (!programs[programName] || (res[id].val !== programs[programName].val) || (res[id].ts !== programs[programName].ts)) {
                    change = true;
                }
                programs[programName] = {
                    id: Number(id),
                    active: res[id].active,
                    ts: res[id].ts
                };
                programNames[Number(id)] = programName;
                if (change) {
                    const topic = config.name + '/status/' + programName;
                    let payload = {
                        val: res[id].active,
                        ts: res[id].ts,
                        lc: res[id].lc,
                        hm: {
                            id: Number(id)
                        }
                    };
                    payload = JSON.stringify(payload);
                    mqttPublish(topic, payload, {retain: true});
                }
            });
            log.debug('rega got', Object.keys(programs).length, 'programs');
            cb(null);
        }
    });
}

log.debug('discover interfaces');
discover(config.ccuAddress, {
    // Todo... cuxd: {port: 8701, protocol: 'binrpc'},
    rfd: {port: 2001, protocol: 'binrpc'},
    hs485d: {port: 2000, protocol: 'binrpc'},
    hmip: {port: 2010, protocol: 'xmlrpc'}
}, interfaces => {
    Object.keys(interfaces).forEach(iface => {
        createIface(iface, interfaces[iface].protocol, interfaces[iface].port);
        if (iface === 'hmip' && config.hmipReconnectInterval) {
            setInterval(() => {
                checkInit(iface, interfaces[iface].protocol);
            }, config.hmipReconnectInterval * 1000);
        } else if (iface === 'cuxd') {
            // TODO
        } else if (config.pingInterval) {
            setInterval(() => {
                checkInit(iface, interfaces[iface].protocol);
            }, config.pingInterval * 1000);
        }
    });
});

function fileName(name) {
    return config.ccuAddress + (name ? '_' + name : '');
}

function checkInit(iface, protocol) {
    const now = (new Date()).getTime();
    const elapsed = Math.ceil((now - (lastEvent[iface] || 0)) / 1000);
    log.debug(iface, 'elapsed since lastevent:', elapsed + 's');
    if (iface === 'hmip' && config.hmipReconnectInterval) {
        if (elapsed >= config.hmipReconnectInterval) {
            initIface(iface, protocol);
        }
    } else if (iface === 'cuxd') {
        // TODO cuxd reconnect? ping possible?
    } else if (elapsed >= (config.pingInterval * 2)) {
        initIface(iface, protocol);
    } else if (elapsed >= config.pingInterval) {
        log.debug('rpc', iface, '> ping');
        rpcClient[iface].methodCall('ping', ['hm2mqtt'], err => {
            if (err) {
                log.error(err);
            }
        });
    }
}

function createIface(name, protocol, port) {
    log.debug('loading', 'devices_' + fileName(name));
    devices[name] = pjson.load('devices_' + fileName(name));
    log.debug('createIface', name, protocol, port);
    if (!rpcServer[protocol]) {
        rpcServer[protocol] = createServer(protocol);
    }
    rpcClient[name] = createClient(protocol, port);
    initIface(name, protocol, port);
}

const stopIface = {};
function stop() {
    const cmdQueue = [];
    Object.keys(stopIface).forEach(iface => {
        cmdQueue.push(stopIface[iface]);
    });
    async.parallel(cmdQueue, () => {
        process.exit(0);
    });
    setTimeout(() => {
        process.exit(1);
    }, 2500);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function initIface(name, protocol) {
    let url;
    if (protocol === 'binrpc') {
        url = 'xmlrpc_bin://' + config.listenAddress + ':' + config.binrpcListenPort;
    } else {
        url = 'http://' + config.listenAddress + ':' + config.listenPort;
    }
    const params = [url, 'hm2mqtt_' + name];
    log.info('rpc', name, '> init', params);
    lastEvent[name] = (new Date()).getTime();
    rpcClient[name].methodCall('init', params, (err, res) => {
        if (err) {
            log.error(err);
        } else {
            log.debug('rpc', name, '< init', JSON.stringify(res));
        }
        stopIface[name] = cb => {
            const stopParams = [url, ''];
            log.info('rpc', name, '> init', stopParams);
            rpcClient[name].methodCall('init', stopParams, (err, res) => {
                log.debug('rpc', name, '< init', err, JSON.stringify(res));
                cb();
            });
        };
    });
}

function createClient(protocol, port) {
    let client;
    const options = {
        host: config.ccuAddress,
        port,
        path: '/'
    };
    if (protocol === 'binrpc') {
        client = binrpc.createClient(options);
    } else {
        client = xmlrpc.createClient(options);
    }
    return client;
}

function paramsetName(dev) {
    return dev.PARENT_TYPE + '/' + dev.VERSION + '/' + dev.TYPE;
}

function createParamsetQueue(name) {
    name = ifaceName(name);
    if (!devices[name]) {
        log.error('createParamsetQueue called for unknown devices', name);
        return;
    }
    log.info(name, 'got', Object.keys(devices[name]).length, 'devices and channels');

    log.debug('createParamsetQueue', name);
    if (!paramsetQueue[name]) {
        paramsetQueue[name] = [];
    }

    Object.keys(devices[name]).forEach(address => {
        const dev = devices[name][address];
        if (!dev.PARENT_TYPE) {
            return;
        }
        if (!paramsetDescriptions[paramsetName(dev)]) {
            log.debug('unknown', paramsetName(dev), dev.PARAMSETS);
            paramsetDescriptions[paramsetName(dev)] = {};
            dev.PARAMSETS.forEach(ps => {
                paramsetQueue[name].push({ADDRESS: dev.ADDRESS, PARAMSET: ps, name: paramsetName(dev)});
            });
        }
    });
    getParamset(name);
}

function getParamset(name) {
    if (paramsetQueue[name].length > 0) {
        const obj = paramsetQueue[name].shift();
        log.debug('rpc', name, '> getParamsetDescription', [obj.ADDRESS, obj.PARAMSET], obj.name);
        rpcClient[name].methodCall('getParamsetDescription', [obj.ADDRESS, obj.PARAMSET], (err, res) => {
            if (!err) {
                paramsetDescriptions[obj.name][obj.PARAMSET] = res;
            }
            setTimeout(() => {
                getParamset(name);
            }, 500);
        });
    } else {
        log.debug('getParamsetDescriptions', name, 'done');
        log.info('got', Object.keys(paramsetDescriptions).length, 'paramsetDescriptions');
        log.debug('saving', 'paramsetDescriptions_' + fileName());
        pjson.save('paramsetDescriptions_' + fileName(), paramsetDescriptions);
    }
}

function ifaceName(id) {
    return id.replace(/^hm2mqtt_/, '');
}

const rpcMethods = {
    notFound: method => {
        log.debug('rpc < Method ' + method + ' does not exist');
    },
    'system.multicall': (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        const res = [];
        params[0].forEach(c => {
            if (rpcMethods[c.methodName]) {
                rpcMethods[c.methodName](err, c.params);
            } else {
                rpcMethods.notFound(c.methodName, c.params);
            }
            res.push('');
        });
        callback(null, res);
    },
    'system.listMethods': (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < system.listMethods', params);
        callback(null, Object.keys(rpcMethods));
    },
    event: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < event', JSON.stringify(params));

        const ts = (new Date()).getTime();
        lastEvent[ifaceName(params[0])] = ts;

        if (params[1] === 'CENTRAL' && params[2] === 'PONG') {
            if (typeof callback === 'function') {
                callback(null, '');
            }
            return;
        }

        if (config.regaPollTrigger) {
            const [regaPollTriggerChannel, regaPollTriggerDatapoint] = config.regaPollTrigger.split('.');
            if (params[1] === regaPollTriggerChannel && params[2] === regaPollTriggerDatapoint) {
                getPrograms(() => {
                    getVariables();
                });
            }
        }

        const key = params[1] + '/' + params[2];
        if (values[key] !== params[3]) {
            changes[key] = ts;
            values[key] = params[3];
        }

        const dev = devices[ifaceName(params[0])] && devices[ifaceName(params[0])][params[1]];
        if (!dev) {
            log.error('unknown device', params[0], params[1]);
            return;
        }
        let ps = paramsetDescriptions[paramsetName(dev)];
        ps = (ps && ps.VALUES && ps.VALUES[params[2]]);
        if (!ps) {
            log.error('unknown paramsetDescription', paramsetName(dev));
            ps = {};
        }

        const topic = config.name + '/status/' + (names[params[1]] || params[1]) + '/' + params[2];

        let payload = {val: params[3], ts, lc: changes[key], hm: {ADDRESS: params[1]}};
        if (ps.UNIT && ps.UNIT !== '""') {
            payload.hm.UNIT = ps.UNIT;
        }
        if (ps.TYPE === 'ENUM') {
            payload.hm.ENUM = ps.VALUE_LIST[params[3]];
        }
        payload = JSON.stringify(payload);

        const retain = ps.TYPE !== 'ACTION';

        mqttPublish(topic, payload, {retain});

        if (typeof callback === 'function') {
            callback(null, '');
        }
    },
    listDevices: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        log.debug('rpc < listDevices', params);
        const name = ifaceName(params[0]);
        const ret = [];
        const test = [];
        if (devices[name]) {
            Object.keys(devices[name]).forEach(address => {
                test.push(devices[name][address]);
                /* Todo This does not work: https://github.com/eq-3/occu/issues/45
                if (name === 'hmip') {
                    ret.push({
                        ADDRESS: address,
                        VERSION: devices[name][address].VERSION,
                        AES_ACTIVE: devices[name][address].AES_ACTIVE,
                        CHILDREN: devices[name][address].CHILDREN,
                        DIRECTION: devices[name][address].DIRECTION,
                        FIRMWARE: devices[name][address].FIRMWARE,
                        FLAGS: devices[name][address].FLAGS,
                        GROUP: devices[name][address].GROUP,
                        INDEX: devices[name][address].INDEX,
                        INTERFACE: devices[name][address].INTERFACE,
                        LINK_SOURCE_ROLES: devices[name][address].LINK_SOURCE_ROLES,
                        LINK_TARGET_ROLES: devices[name][address].LINK_TARGET_ROLES,
                        PARAMSETS: devices[name][address].PARAMSETS,
                        PARENT: devices[name][address].PARENT,
                        PARENT_TYPE: devices[name][address].PARENT_TYPE,
                        RF_ADDRESS: devices[name][address].RF_ADDRESS,
                        ROAMING: devices[name][address].ROAMING,
                        RX_MODE: devices[name][address].RX_MODE,
                        TEAM: devices[name][address].TEAM,
                        TEAM_CHANNELS: devices[name][address].TEAM_CHANNELS,
                        TEAM_TAG: devices[name][address].TEAM_TAG,
                        TYPE: devices[name][address].TYPE
                    });
                } else {
                    ret.push({
                        ADDRESS: address,
                        VERSION: devices[name][address].VERSION
                    });
                }
                 */
                ret.push({
                    ADDRESS: address,
                    VERSION: devices[name][address].VERSION
                });
            });
        }
        log.debug('>', ret.length);
        callback(null, ret);
        getParamsetTimeout[params[0]] = setTimeout(() => {
            createParamsetQueue(params[0]);
        }, 5000);
    },
    deleteDevices: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        clearTimeout(getParamsetTimeout[params[0]]);
        log.debug('rpc < deleteDevices', params[1].length);
        const name = ifaceName(params[0]);
        params[1].forEach(dev => {
            delete devices[name][dev];
        });
        log.debug('saving', 'devices_' + fileName(name), '(' + Object.keys(devices[name]).length + ')');
        pjson.save('devices_' + fileName(name), devices[name]);
        callback(null, '');
        getParamsetTimeout[params[0]] = setTimeout(() => {
            createParamsetQueue(params[0]);
        }, 5000);
    },
    newDevices: (err, params, callback) => {
        if (err) {
            log.error(err);
            return;
        }
        clearTimeout(getParamsetTimeout[params[0]]);
        log.debug('rpc < newDevices', params[1].length);
        const name = ifaceName(params[0]);
        const devs = devices[name] || {};
        params[1].forEach(dev => {
            devs[dev.ADDRESS] = dev;
        });
        devices[name] = devs;
        log.debug('saving', 'devices_' + fileName(name), '(' + Object.keys(devices[name]).length + ')');
        pjson.save('devices_' + fileName(name), devs);
        callback(null, '');
        getParamsetTimeout[params[0]] = setTimeout(() => {
            createParamsetQueue(params[0]);
        }, 5000);
    }
};

rpcMethods.NotFound = rpcMethods.notFound;

function createServer(protocol) {
    let server;
    if (protocol === 'binrpc') {
        server = binrpc.createServer({host: config.listenAddress, port: config.binrpcListenPort});
    } else {
        server = xmlrpc.createServer({host: config.listenAddress, port: config.listenPort});
    }
    Object.keys(rpcMethods).forEach(method => {
        server.on(method, rpcMethods[method]);
    });
    return server;
}
