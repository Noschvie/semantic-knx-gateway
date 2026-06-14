// SPDX-License-Identifier: CC-BY-NC-SA-4.0
// Copyright (c) 2026 Noschvie
// KNX Runtime Engine – https://github.com/Noschvie/semantic-knx-gateway.git

/**
 * Mapping from symbolic DPT names (from TTL/ETS) to numeric DPT strings.
 * Shared by TelegramDecoder and GraphBuilder.
 */
export const DPT_NAME_MAP = {
    // DPT 1.x – Boolean
    'boolean':          '1.001',
    'bool':             '1.001',
    'switch':           '1.001',
    'enable':           '1.003',
    'ramp':             '1.004',
    'alarm':            '1.005',
    'binaryValue':      '1.006',
    'step':             '1.007',
    'upDown':           '1.008',
    'openClose':        '1.009',
    'start':            '1.010',
    'state':            '1.011',
    'invert':           '1.012',
    'dimmSendStyle':    '1.013',
    'inputSource':      '1.014',
    'reset':            '1.015',
    'ack':              '1.016',
    'trigger':          '1.017',
    'occupancy':        '1.018',
    'windowDoor':       '1.019',
    'logicalFunction':  '1.021',
    'sceneAB':          '1.022',
    'shutter':          '1.023',

    // DPT 3.x - 4-bit dimming/blinds
    'dimming':          '3.007',
    'blinds':           '3.008',

    // DPT 5.x – 8-Bit unsigned
    'percent':          '5.001',
    'scaling':          '5.001',
    'angle':            '5.003',
    'counter8':         '5.010',
    'tariff':           '5.006',

    // DPT 6.x – 8-Bit signed
    'counter8s':        '6.010',

    // DPT 7.x – 16-Bit unsigned
    'counter16':        '7.001',
    'timePeriodMs':     '7.002',
    'timePeriodSec':    '7.003',
    'timePeriodMin':    '7.004',
    'timePeriodHrs':    '7.005',
    'value2Ucount':     '7.001',
    'propDataType':     '7.010',

    // DPT 8.x – 16-Bit signed
    'value2Count':      '8.001',
    'deltaTime100ms':   '8.002',
    'deltaTimeSec':     '8.003',
    'deltaTimeMin':     '8.004',
    'deltaTimeHrs':     '8.005',

    // DPT 9.x – 2-Byte float
    'temperature':      '9.001',
    'temperatureDiff':  '9.002',
    'kelvin':           '9.003',
    'lux':              '9.004',
    'speed':            '9.005',
    'pressure':         '9.006',
    'humidity':         '9.007',
    'airQuality':       '9.008',
    'voltage':          '9.020',
    'current':          '9.021',
    'power':            '9.024',
    'valueTemp':        '9.001',
    'valueLux':         '9.004',
    'valueHumidity':    '9.007',
    'valuePpm':         '9.008',
    'valueWsp':         '9.005',
    'valueVolt':        '9.020',
    'valueCurr':        '9.021',
    'valuePower':       '9.024',
    'valueTempF':       '9.010',
    'valueWind':        '9.005',
    'valueAngl':        '9.006',

    // DPT 10.x - time
    'timeOfDay':        '10.001',

    // DPT 11.x - date
    'date':             '11.001',

    // DPT 12.x – 32-Bit unsigned
    'counter32':        '12.001',

    // DPT 13.x – 32-Bit signed
    'counter32s':       '13.001',

    // DPT 14.x – 4-Byte float
    'float4':           '14.005',
    'electricCurrent':  '14.019',
    'electricPotential':'14.027',
    'frequency':        '14.033',
    'power14':          '14.056',

    // DPT 16.x – String
    'string':           '16.001',
    'stringLatin':      '16.000',

    // DPT 17.x - scene number
    'scene':            '17.001',

    // DPT 18.x - scene control
    'sceneControl':     '18.001',

    // DPT 19.x - date+time
    'datetime':         '19.001',

    // DPT 20.x – 8-Bit enum
    'hvacMode':         '20.102',
};

export const DPT_TO_DATAPOINT_TYPE = {
    // DPT 1.x – Boolean/Switch
    '1.001': 'knx:switch',
    '1.003': 'knx:enable',
    '1.005': 'knx:alarm',
    '1.008': 'knx:upDown',
    '1.009': 'knx:openClose',
    '1.011': 'knx:state',
    '1.018': 'knx:occupancy',
    '1.019': 'knx:windowDoor',
    // DPT 3.x
    '3.007': 'knx:dimming',
    '3.008': 'knx:blinds',
    // DPT 5.x
    '5.001': 'knx:scaling',
    '5.003': 'knx:angle',
    '5.010': 'knx:counter8',
    // DPT 9.x – Float
    '9.001': 'knx:temperature',
    '9.004': 'knx:lux',
    '9.007': 'knx:humidity',
    '9.008': 'knx:airQuality',
    '9.020': 'knx:voltage',
    '9.021': 'knx:current',
    '9.024': 'knx:power',
    // DPT 10–11
    '10.001': 'knx:timeOfDay',
    '11.001': 'knx:date',
    // DPT 16
    '16.001': 'knx:string',
    // DPT 17–20
    '17.001': 'knx:scene',
    '20.102': 'knx:hvacMode',
};

