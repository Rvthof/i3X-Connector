import type { Microflows, StudioProApi, Texts } from '@mendix/extensions-api';
import type { ConnectionConfig } from '../types';
import { configureHttpAuthForMicroflow } from './auth';

export interface RestMicroflowOptions {
    url: string;
    requestBody: string;
    extraHeaders?: Array<{ key: string; value: string }>;
    connection: ConnectionConfig;
    importMappingId?: string;
}

export function buildValueQueryHttpRequestBody(selectedElementId: string): string {
    return `{
  "elementIds": [
    "${selectedElementId}"
  ],
  "maxDepth": 1
}`;
}

export function buildValueQueryMicroflowRequestBody(selectedElementId: string): string {
    return `{{
  "elementIds": [
    "${selectedElementId}"
  ],
  "maxDepth": 1
}`;
}

async function addHttpHeadersToConfiguration(
    sp: StudioProApi,
    httpConfiguration: Microflows.HttpConfiguration,
    headers: Array<{ key: string; value: string }>
): Promise<void> {
    for (const { key, value } of headers) {
        const headerEntry = (await sp.app.model.microflows.createElement(
            'Microflows$HttpHeaderEntry'
        )) as Microflows.HttpHeaderEntry;
        headerEntry.key = key;
        headerEntry.value = value;
        httpConfiguration.headerEntries.push(headerEntry);
    }
}

async function createSequenceFlow(
    sp: StudioProApi,
    startId: string,
    endId: string,
    exclusiveSplitValue?: boolean
): Promise<Microflows.SequenceFlow> {
    const sequenceFlow = (await sp.app.model.microflows.createElement(
        'Microflows$SequenceFlow'
    )) as Microflows.SequenceFlow;
    sequenceFlow.origin = startId;
    sequenceFlow.destination = endId;
    if (exclusiveSplitValue !== undefined) {
        const caseValue = (await sp.app.model.microflows.createElement(
            'Microflows$EnumerationCase'
        )) as Microflows.EnumerationCase;
        caseValue.value = exclusiveSplitValue ? 'true' : 'false';
        sequenceFlow.caseValues = [caseValue];
    }
    return sequenceFlow;
}

async function createMessageActivity(
    sp: StudioProApi,
    type: Microflows.ShowMessageType,
    messageText: string,
    expressionArgs: string[],
    languageCode: string
): Promise<Microflows.ActionActivity> {
    const messageActivity = (await sp.app.model.microflows.createElement(
        'Microflows$ActionActivity'
    )) as Microflows.ActionActivity;
    const showMessage = (await sp.app.model.microflows.createElement(
        'Microflows$ShowMessageAction'
    )) as Microflows.ShowMessageAction;
    const textTemplate = (await sp.app.model.microflows.createElement(
        'Microflows$TextTemplate'
    )) as Microflows.TextTemplate;
    const text = (await sp.app.model.microflows.createElement('Texts$Text')) as Texts.Text;
    const translation = (await sp.app.model.microflows.createElement(
        'Texts$Translation'
    )) as Texts.Translation;

    for (const arg of expressionArgs) {
        const templateArg = (await sp.app.model.microflows.createElement(
            'Microflows$TemplateArgument'
        )) as Microflows.TemplateArgument;
        templateArg.expression = arg;
        textTemplate.arguments.push(templateArg);
    }

    translation.languageCode = languageCode;
    translation.text = messageText;
    text.translations.push(translation);

    textTemplate.text = text;
    showMessage.type = type;
    showMessage.template = textTemplate;
    messageActivity.action = showMessage;
    return messageActivity;
}

/**
 * Populate a fresh microflow with the shared REST-call pattern used by both
 * object implementation and value-query generation flows.
 */
export async function populateMicroflowWithRestCall(
    sp: StudioProApi,
    microflow: Microflows.Microflow,
    options: RestMicroflowOptions
): Promise<void> {
    const { url, requestBody, extraHeaders = [], connection, importMappingId } = options;

    const actionActivity = (await sp.app.model.microflows.createElement(
        'Microflows$ActionActivity'
    )) as Microflows.ActionActivity;
    const restCall = (await sp.app.model.microflows.createElement(
        'Microflows$RestCallAction'
    )) as Microflows.RestCallAction;
    const httpConfiguration = (await sp.app.model.microflows.createElement(
        'Microflows$HttpConfiguration'
    )) as Microflows.HttpConfiguration;
    const requestHandler = (await sp.app.model.microflows.createElement(
        'Microflows$CustomRequestHandling'
    )) as Microflows.CustomRequestHandling;
    const requestTemplate = (await sp.app.model.microflows.createElement(
        'Microflows$StringTemplate'
    )) as Microflows.StringTemplate;
    const locationTemplate = (await sp.app.model.microflows.createElement(
        'Microflows$StringTemplate'
    )) as Microflows.StringTemplate;
    const locationTemplateArg = (await sp.app.model.microflows.createElement(
        'Microflows$TemplateArgument'
    )) as Microflows.TemplateArgument;
    const resultHandling = (await sp.app.model.microflows.createElement(
        'Microflows$ResultHandling'
    )) as Microflows.ResultHandling;
    const stringType = await sp.app.model.microflows.createElement('DataTypes$StringType');

    requestTemplate.text = requestBody;
    requestHandler.template = requestTemplate;
    restCall.requestHandling = requestHandler;
    restCall.requestHandlingType = 'Custom';

    httpConfiguration.overrideLocation = true;
    locationTemplate.text = '{1}';
    locationTemplateArg.expression = `'${url}'`;
    locationTemplate.arguments = [locationTemplateArg];
    httpConfiguration.customLocationTemplate = locationTemplate;
    await configureHttpAuthForMicroflow(sp, httpConfiguration, connection.auth);
    await addHttpHeadersToConfiguration(sp, httpConfiguration, extraHeaders);
    restCall.httpConfiguration = httpConfiguration;

    resultHandling.variableType = stringType as typeof resultHandling.variableType;

    // Mendix 11.10 exposes the REST import-mapping hooks needed to bind
    // ImportMappingCall directly to RestCallAction result handling. On the
    // current GA extensions API version, creating that model shape causes the
    // microflow operation to fail, so keep the REST action in string mode for now.
    void importMappingId;
    resultHandling.storeInVariable = true;
    resultHandling.outputVariableName = 'ResponseBody';
    restCall.resultHandlingType = 'String';

    restCall.resultHandling = resultHandling;
    restCall.errorResultHandlingType = 'None';
    restCall.timeOutExpression = '300';

    actionActivity.action = restCall;
    actionActivity.size = { width: 120, height: 60 };
    actionActivity.relativeMiddlePoint = { x: 400, y: 200 };
    microflow.objectCollection.objects.push(actionActivity);

    const exclusiveSplit = (await sp.app.model.microflows.createElement(
        'Microflows$ExclusiveSplit'
    )) as Microflows.ExclusiveSplit;
    const splitCondition = (await sp.app.model.microflows.createElement(
        'Microflows$ExpressionSplitCondition'
    )) as Microflows.ExpressionSplitCondition;
    splitCondition.expression = '$latestHttpResponse/StatusCode = 200';
    exclusiveSplit.splitCondition = splitCondition;
    exclusiveSplit.size = { width: 60, height: 60 };
    exclusiveSplit.relativeMiddlePoint = { x: 600, y: 200 };
    microflow.objectCollection.objects.push(exclusiveSplit);

    if (microflow.flows.length > 0) {
        microflow.flows.pop();
    }

    const startEvent = microflow.objectCollection.objects[0];
    const endEvent = microflow.objectCollection.objects[1];
    endEvent.relativeMiddlePoint = { x: 900, y: 200 };
    microflow.flows.push(await createSequenceFlow(sp, startEvent.$ID, actionActivity.$ID));
    microflow.flows.push(await createSequenceFlow(sp, actionActivity.$ID, exclusiveSplit.$ID));

    const successActivity = await createMessageActivity(
        sp,
        'Information',
        importMappingId
            ? 'Successfully received and mapped response from i3X API.'
            : 'Successfully received response from i3X API. Response: {1}',
        importMappingId ? [] : ['$ResponseBody'],
        'en_US'
    );
    successActivity.size = { width: 120, height: 60 };
    successActivity.relativeMiddlePoint = { x: 800, y: 200 };
    microflow.objectCollection.objects.push(successActivity);
    microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, successActivity.$ID, true));
    microflow.flows.push(await createSequenceFlow(sp, successActivity.$ID, endEvent.$ID));

    const errorActivity = await createMessageActivity(
        sp,
        'Error',
        'Error: Received status code {1} from i3X API.',
        ['toString($latestHttpResponse/StatusCode)'],
        'en_US'
    );
    errorActivity.size = { width: 120, height: 60 };
    errorActivity.relativeMiddlePoint = { x: 800, y: 300 };
    microflow.objectCollection.objects.push(errorActivity);
    microflow.flows.push(await createSequenceFlow(sp, exclusiveSplit.$ID, errorActivity.$ID, false));

    const errorEndEvent = (await sp.app.model.microflows.createElement(
        'Microflows$EndEvent'
    )) as Microflows.EndEvent;
    errorEndEvent.relativeMiddlePoint = { x: 900, y: 300 };
    microflow.objectCollection.objects.push(errorEndEvent);
    microflow.flows.push(await createSequenceFlow(sp, errorActivity.$ID, errorEndEvent.$ID));
}