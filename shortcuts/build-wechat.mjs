import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Generates editable source. iOS 15 requires signing before importing it.
const uuid = () => randomUUID().toUpperCase();
const ids = Object.fromEntries(['server', 'poll', 'result', 'flag', 'group', 'job', 'token', 'delay', 'delayGroup'].map((key) => [key, uuid()]));
const output = (key) => ({ Type: 'ActionOutput', OutputUUID: ids[key], OutputName: key });
const variable = (key) => ({ WFSerializationType: 'WFTextTokenAttachment', Value: output(key) });
const text = (string, attachmentsByRange) => ({
  WFSerializationType: 'WFTextTokenString',
  Value: { string, ...(attachmentsByRange ? { attachmentsByRange } : {}) },
});
const tokenText = (key, suffix = '') => text(`\uFFFC${suffix}`, { '{0, 1}': output(key) });
const dictionary = (entries) => ({
  WFSerializationType: 'WFDictionaryFieldValue',
  Value: {
    WFDictionaryFieldValueItems: entries.map(([key, value]) => ({
      WFItemType: 0, WFKey: text(key), WFValue: value,
    })),
  },
});
const action = (identifier, parameters) => ({
  WFWorkflowActionIdentifier: `is.workflow.actions.${identifier}`,
  WFWorkflowActionParameters: parameters,
});
const getValue = (key, name) => action('getvalueforkey', {
  WFInput: variable('result'), WFDictionaryKey: name, UUID: ids[key],
});
const post = (path, entries, id = uuid()) => action('downloadurl', {
  WFURL: tokenText('server', path),
  WFHTTPMethod: 'POST',
  WFHTTPBodyType: 'JSON',
  WFJSONValues: dictionary(entries),
  UUID: id,
});

const workflow = {
  WFWorkflowName: '查询打卡-微信测试',
  WFWorkflowClientVersion: '800',
  WFWorkflowMinimumClientVersion: 800,
  WFWorkflowMinimumClientVersionString: '800',
  WFWorkflowIcon: { WFWorkflowIconStartColor: 431817727, WFWorkflowIconGlyphNumber: 61440 },
  WFWorkflowTypes: [],
  WFQuickActionSurfaces: [],
  WFWorkflowInputContentItemClasses: [],
  WFWorkflowImportQuestions: [{
    Category: 'Parameter', ActionIndex: 0, ParameterKey: 'WFTextActionText',
    Text: '填写服务器地址，例如 http://你的服务器IP:2580，末尾不要加 /',
    DefaultValue: 'http://YOUR_SERVER_IP:2580',
  }],
  WFWorkflowActions: [
    action('gettext', { WFTextActionText: 'http://YOUR_SERVER_IP:2580', UUID: ids.server }),
    post('/api/device/poll', [], ids.poll),
    action('getdictionaryfrominput', { WFInput: variable('poll'), UUID: ids.result }),
    getValue('flag', 'shouldRun'),
    action('conditional', {
      GroupingIdentifier: ids.group,
      WFControlFlowMode: 0,
      WFInput: {
        Type: 'Variable',
        Variable: {
          WFSerializationType: 'WFTextTokenAttachment',
          Value: {
            ...output('flag'),
            Aggrandizements: [{ Type: 'WFCoercionVariableAggrandizement', CoercionItemClass: 'WFNumberContentItem' }],
          },
        },
      },
      WFCondition: 4,
      WFNumberValue: 1,
    }),
    getValue('job', 'jobId'),
    getValue('token', 'ackToken'),
    getValue('delay', 'delaySeconds'),
    action('conditional', {
      GroupingIdentifier: ids.delayGroup,
      WFControlFlowMode: 0,
      WFInput: {
        Type: 'Variable',
        Variable: {
          WFSerializationType: 'WFTextTokenAttachment',
          Value: {
            ...output('delay'),
            Aggrandizements: [{ Type: 'WFCoercionVariableAggrandizement', CoercionItemClass: 'WFNumberContentItem' }],
          },
        },
      },
      WFCondition: 2,
      WFNumberValue: 0,
    }),
    action('delay', { WFDelayTime: variable('delay') }),
    action('conditional', { GroupingIdentifier: ids.delayGroup, WFControlFlowMode: 2, UUID: uuid() }),
    action('openapp', { WFAppIdentifier: 'com.tencent.xin', WFSelectedApp: { BundleIdentifier: 'com.tencent.xin' } }),
    post('/api/device/ack', [['jobId', tokenText('job')], ['ackToken', tokenText('token')]]),
    action('conditional', { GroupingIdentifier: ids.group, WFControlFlowMode: 2, UUID: uuid() }),
  ],
};

const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function plist(value) {
  if (typeof value === 'string') return `<string>${escape(value)}</string>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (typeof value === 'boolean') return `<${value}/>`;
  if (Array.isArray(value)) return `<array>${value.map(plist).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, item]) => `<key>${escape(key)}</key>${plist(item)}`).join('')}</dict>`;
}
const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  + `<plist version="1.0">${plist(workflow)}</plist>\n`;
await writeFile(new URL('./wechat-checkin.plist', import.meta.url), xml);
console.log('Generated shortcuts/wechat-checkin.plist (unsigned source; signing is required).');
