import type { StudioProApi } from '@mendix/extensions-api';
import type { DomainModels } from '@mendix/extensions-api';
import type { Microflows } from '@mendix/extensions-api';
import type { Projects } from '@mendix/extensions-api';
import type { Texts } from '@mendix/extensions-api';
import { isGroupProperty, isArrayProperty, extractArrayItemProperties, type AnyProperty, type ArrayProperty, type ConnectionConfig, type LeafProperty, type ObjectType } from '../types';
import { getObjectsUrl, getObjectsValueUrl } from './i3xUrl';
import { buildI3xRequestHeaders, configureHttpAuthForMicroflow } from './auth';

let studioPro: StudioProApi | null = null;

export function initStudioPro(sp: StudioProApi): void {
    studioPro = sp;
}

export function getStudioPro(): StudioProApi {
    if (!studioPro) {
        throw new Error('StudioPro not initialized. Call initStudioPro() first.');
    }
    return studioPro;
}

export interface ImplementEntityResult {
    baseEntityName: string;
    baseEntityCreated: boolean;
    groupEntitiesCreated: number;
    attributesCreated: number;
    associationsCreated: number;
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
    microflowName: string;
    microflowCreated: boolean;
}

export interface QueryValuesMicroflowResult {
    baseEntityName: string;
    baseEntityCreated: boolean;
    groupEntitiesCreated: number;
    attributesCreated: number;
    associationsCreated: number;
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
    microflowName: string;
    microflowCreated: boolean;
}

interface JsonStructureResult {
    created: boolean;
    jsonStructureId: string;
}

interface ImportMappingResult {
    created: boolean;
    mappingId: string;
}

interface JsonSampleResponse {
    parsed: unknown;
    rawText: string;
}

interface ValueQueryArtifactsResult extends DomainModelResult {
    jsonStructureName: string;
    jsonStructureCreated: boolean;
    importMappingName: string;
    importMappingCreated: boolean;
    importMappingId: string;
}

type ModuleLookupApi = {
    getModule(name: string): Promise<Readonly<Projects.Module> | null>;
};

type MendixAttributeType = NonNullable<DomainModels.AttributeCreationOptions['type']>;
const MENDIX_LONG_MIN = Number('-9223372036854775808');
const MENDIX_LONG_MAX = Number('9223372036854775807');

// ── Layout constants ──────────────────────────────────────────────────────────
const ATTR_ROW_H  = 20;   // px per attribute row
const ENTITY_HDR_H = 30;  // px for entity header
const H_GAP        = 80;  // horizontal gap between base and group column
const V_GAP        = 40;  // vertical gap between group entities
const BASE_WIDTH   = 200; // base entity column width

function entityHeight(attrCount: number): number {
    return ENTITY_HDR_H + Math.max(1, attrCount) * ATTR_ROW_H;
}

function toModelName(raw: string): string {
    const compact = raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    const startsWithLetter = /^[A-Za-z]/.test(compact) ? compact : `N_${compact}`;
    return startsWithLetter || 'Unnamed';
}

function getAttributeType(property: LeafProperty): MendixAttributeType {
    if (property.type === 'string') {
        if (property.format === 'date-time' || property.format === 'date') {
            return 'DateTime';
        }
        return 'String';
    }

    if (property.type === 'boolean') {
        return 'Boolean';
    }

    if (property.type === 'integer') {
        if (property.format === 'int64' || property.format === 'long') {
            return 'Long';
        }
        return 'Integer';
    }

    if (property.type === 'number') {
        return 'Decimal';
    }

    return 'String';
}

function clampToMendixLong(value: number): number {
    if (!Number.isFinite(value)) return value;
    if (value < MENDIX_LONG_MIN) return MENDIX_LONG_MIN;
    if (value > MENDIX_LONG_MAX) return MENDIX_LONG_MAX;
    return value;
}

function sanitizeJsonForMendixLimits(value: unknown, parentKey?: string): unknown {
    if (Array.isArray(value)) {
        return value.map(item => sanitizeJsonForMendixLimits(item));
    }

    if (value !== null && typeof value === 'object') {
        const sanitized: Record<string, unknown> = {};
        for (const [key, childValue] of Object.entries(value)) {
            sanitized[key] = sanitizeJsonForMendixLimits(childValue, key);
        }
        return sanitized;
    }

    if (typeof value === 'number' && (parentKey === 'minimum' || parentKey === 'maximum')) {
        return clampToMendixLong(value);
    }

    return value;
}

function getOrCreateEntityName(
    domainModel: DomainModels.DomainModel,
    preferredName: string
): { name: string; created: boolean } {
    const normalized = toModelName(preferredName);
    const existing = domainModel.getEntity(normalized);
    if (existing) {
        return { name: normalized, created: false };
    }
    return { name: normalized, created: true };
}

function getNestedProperties(property: AnyProperty): Record<string, AnyProperty> | null {
    if (isGroupProperty(property)) {
        return property.properties as Record<string, AnyProperty>;
    }

    if (isArrayProperty(property)) {
        return extractArrayItemProperties(property) as Record<string, AnyProperty> | null;
    }

    return null;
}

function countDirectLeafProperties(properties: Record<string, AnyProperty>): number {
    return Object.values(properties).filter(property => getNestedProperties(property) === null).length;
}

function buildValueQueryHttpRequestBody(selectedElementId: string): string {
    return `{\n  "elementIds": [\n    "${selectedElementId}"\n  ],\n  "maxDepth": 1\n}`;
}

function buildValueQueryMicroflowRequestBody(selectedElementId: string): string {
    return `{{\n  "elementIds": [\n    "${selectedElementId}"\n  ],\n  "maxDepth": 1\n}`;
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

function mergeObjectSamples(items: unknown[]): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    let hasObject = false;

    for (const item of items) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        hasObject = true;
        for (const [key, value] of Object.entries(item)) {
            if (!(key in merged) || merged[key] == null) {
                merged[key] = value;
            }
        }
    }

    return hasObject ? merged : null;
}

function getRepresentativeArrayItem(items: unknown[]): unknown {
    const mergedObject = mergeObjectSamples(items);
    if (mergedObject) {
        return mergedObject;
    }

    for (const item of items) {
        if (item !== null && item !== undefined) {
            return item;
        }
    }

    return '';
}

function inferPropertyFromSample(value: unknown): AnyProperty {
    if (Array.isArray(value)) {
        const itemSample = getRepresentativeArrayItem(value);
        return {
            type: 'array',
            items: itemSample !== null && typeof itemSample === 'object' && !Array.isArray(itemSample)
                ? {
                    type: 'object',
                    properties: Object.fromEntries(
                        Object.entries(itemSample).map(([key, childValue]) => [key, inferPropertyFromSample(childValue)])
                    ),
                }
                : inferPropertyFromSample(itemSample),
        };
    }

    if (value !== null && typeof value === 'object') {
        return {
            type: 'object',
            properties: Object.fromEntries(
                Object.entries(value).map(([key, childValue]) => [key, inferPropertyFromSample(childValue)])
            ),
        };
    }

    if (typeof value === 'boolean') {
        return { type: 'boolean' };
    }

    if (typeof value === 'number') {
        return { type: 'number' };
    }

    return { type: 'string' };
}

function normalizeSampleForMapping(sample: unknown): Record<string, unknown> {
    if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
        return sample as Record<string, unknown>;
    }

    if (Array.isArray(sample)) {
        const representativeItem = getRepresentativeArrayItem(sample);
        if (
            representativeItem !== null &&
            typeof representativeItem === 'object' &&
            !Array.isArray(representativeItem)
        ) {
            return representativeItem as Record<string, unknown>;
        }

        return { value: representativeItem };
    }

    return { value: sample };
}

function mergeValueQueryDataPoint(dataPoint: unknown): unknown {
    if (dataPoint === null || typeof dataPoint !== 'object' || Array.isArray(dataPoint)) {
        return dataPoint;
    }

    const pointRecord = dataPoint as Record<string, unknown>;
    const valuePayload = pointRecord.value;

    if (valuePayload !== null && typeof valuePayload === 'object' && !Array.isArray(valuePayload)) {
        const mergedPayload = {
            ...(valuePayload as Record<string, unknown>),
        };

        for (const [key, value] of Object.entries(pointRecord)) {
            if (key === 'value' || key in mergedPayload) {
                continue;
            }
            mergedPayload[key] = value;
        }

        return mergedPayload;
    }

    return pointRecord;
}

function extractValueQueryPayload(sample: unknown): unknown {
    const normalizedSample = normalizeSampleForMapping(sample);

    const responseContainers = Object.values(normalizedSample).filter(
        (value): value is Record<string, unknown> =>
            value !== null && typeof value === 'object' && !Array.isArray(value)
    );

    const dataArrays = responseContainers
        .map(container => container.data)
        .filter((value): value is unknown[] => Array.isArray(value));

    if (dataArrays.length === 0) {
        return normalizedSample;
    }

    const mergedDataPoint = mergeObjectSamples(
        dataArrays
            .flat()
            .map(mergeValueQueryDataPoint)
            .filter(
                (value): value is Record<string, unknown> =>
                    value !== null && typeof value === 'object' && !Array.isArray(value)
            )
    );

    return mergedDataPoint ?? mergeValueQueryDataPoint(getRepresentativeArrayItem(dataArrays.flat()));
}

function buildObjectTypeFromSample(displayName: string, sample: unknown): ObjectType {
    const normalizedSample = normalizeSampleForMapping(sample);
    const rootProperty = inferPropertyFromSample(normalizedSample);

    return {
        elementId: '',
        displayName,
        namespaceUri: '',
        schema: {
            type: 'object',
            properties: isGroupProperty(rootProperty) ? rootProperty.properties : { value: rootProperty },
        },
    };
}

async function fetchJsonSample(
    sp: StudioProApi,
    url: string,
    connection: ConnectionConfig,
    init?: RequestInit
): Promise<unknown> {
    const responseData = await fetchJsonSampleResponse(sp, url, connection, init);
    return responseData.parsed;
}

async function fetchJsonSampleResponse(
    sp: StudioProApi,
    url: string,
    connection: ConnectionConfig,
    init?: RequestInit
): Promise<JsonSampleResponse> {
    const proxyUrl = await sp.network.httpProxy.getProxyUrl(url);
    const response = await fetch(proxyUrl, {
        ...init,
        headers: {
            ...buildI3xRequestHeaders(connection.auth),
            ...(init?.headers ?? {}),
        },
    });

    if (!response.ok) {
        const responseText = (await response.text()).trim();
        const details = responseText ? ` Response: ${responseText}` : '';
        throw new Error(`i3X request failed with status ${response.status} for '${url}'.${details}`);
    }

    const rawText = await response.text();
    return {
        parsed: JSON.parse(rawText),
        rawText,
    };
}

async function getProjectModule(
    sp: StudioProApi,
    moduleName: string
): Promise<Readonly<Projects.Module> | null> {
    const modelWithModules = sp.app.model as typeof sp.app.model & {
        modules?: ModuleLookupApi;
    };

    const moduleApi = modelWithModules.modules ?? (sp.app.model.projects as ModuleLookupApi);
    return moduleApi.getModule(moduleName);
}

async function createSequenceFlow(
    sp: StudioProApi,
    startId: string,
    endId: string,
    exclSplitValue?: boolean
): Promise<Microflows.SequenceFlow> {
    const sequenceFlow = (await sp.app.model.microflows.createElement(
        'Microflows$SequenceFlow'
    )) as Microflows.SequenceFlow;
    sequenceFlow.origin = startId;
    sequenceFlow.destination = endId;
    if (exclSplitValue !== undefined) {
        const caseValue = (await sp.app.model.microflows.createElement(
            'Microflows$EnumerationCase'
        )) as Microflows.EnumerationCase;
        caseValue.value = exclSplitValue ? 'true' : 'false';
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

// ── Shared microflow builder ──────────────────────────────────────────────────

interface RestMicroflowOptions {
    url: string;
    requestBody: string;
    extraHeaders?: Array<{ key: string; value: string }>;
    connection: ConnectionConfig;
    importMappingId?: string;
}

/**
 * Populates a freshly created microflow with a REST call → status-code split →
 * success/error message pattern. Both the object-list and value-query microflows
 * share this structure; they differ only in request body and extra headers.
 */
async function populateMicroflowWithRestCall(
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

// ── Domain model helpers ──────────────────────────────────────────────────────

interface DomainModelResult {
    baseEntityName: string;
    baseEntityCreated: boolean;
    groupEntitiesCreated: number;
    attributesCreated: number;
    associationsCreated: number;
}

async function buildDomainModelEntities(
    sp: StudioProApi,
    selectedObject: ObjectType,
    moduleName: string
): Promise<DomainModelResult> {
    const baseEntityName = toModelName(selectedObject.displayName);
    if (!baseEntityName) {
        throw new Error('Selected object has no valid name.');
    }

    const domainModel = await sp.app.model.domainModels.getDomainModel(moduleName);
    if (!domainModel) {
        throw new Error(`Module '${moduleName}' was not found or has no domain model.`);
    }

    const allProperties = selectedObject.schema.properties ?? {};

    const groupEntryList = Object.entries(allProperties).filter(([, p]) => getNestedProperties(p) !== null);
    const leafCount = Object.entries(allProperties).filter(
        ([, p]) => getNestedProperties(p) === null
    ).length;
    const baseHeight = entityHeight(leafCount);

    // Place new entities below any existing ones to avoid overlap.
    let startY = 0;
    for (const ent of domainModel.entities) {
        const bottom = ent.location.y + ENTITY_HDR_H + ATTR_ROW_H + V_GAP;
        if (bottom > startY) startY = bottom;
    }

    // Centre the base entity vertically against the group column.
    const groupColumnHeight = groupEntryList.reduce((sum, [, p]) => {
        const attrCount = countDirectLeafProperties(getNestedProperties(p) ?? {});
        return sum + entityHeight(attrCount) + V_GAP;
    }, -V_GAP);
    const baseY = startY + Math.max(0, (groupColumnHeight - baseHeight) / 2);

    let baseEntityCreated = false;
    if (!domainModel.getEntity(baseEntityName)) {
        const entity = await domainModel.addEntity({ name: baseEntityName });
        if (entity.generalization.$Type === 'DomainModels$NoGeneralization') {
            entity.generalization.persistable = false;
        }
        baseEntityCreated = true;
    }

    const baseEntityObj = domainModel.getEntity(baseEntityName);
    if (baseEntityObj && baseEntityCreated) {
        baseEntityObj.location = { x: 0, y: baseY };
    }

    let groupEntitiesCreated = 0;
    let attributesCreated = 0;
    let associationsCreated = 0;
    let nextNestedEntityY = startY;

    const populateEntityProperties = async (
        parentEntityName: string,
        parentEntity: DomainModels.Entity,
        properties: Record<string, AnyProperty>,
        depth: number
    ): Promise<void> => {
        for (const [propertyName, property] of Object.entries(properties)) {
            const nestedProperties = getNestedProperties(property);

            if (nestedProperties) {
                const isResolvableArray = isArrayProperty(property);
                const preferredGroupEntityName = `${parentEntityName}_${propertyName}`;
                const groupEntityInfo = getOrCreateEntityName(domainModel, preferredGroupEntityName);

                if (groupEntityInfo.created) {
                    const entity = await domainModel.addEntity({ name: groupEntityInfo.name });
                    if (entity.generalization.$Type === 'DomainModels$NoGeneralization') {
                        entity.generalization.persistable = false;
                    }
                    groupEntitiesCreated += 1;
                }

                const groupEntity = domainModel.getEntity(groupEntityInfo.name);
                if (!groupEntity) {
                    throw new Error(`Failed to access generated entity '${groupEntityInfo.name}'.`);
                }

                if (groupEntityInfo.created) {
                    groupEntity.location = {
                        x: depth * (BASE_WIDTH + H_GAP),
                        y: nextNestedEntityY,
                    };
                    nextNestedEntityY += entityHeight(countDirectLeafProperties(nestedProperties)) + V_GAP;
                }

                const assocName = `${parentEntityName}_${groupEntityInfo.name}`;
                if (!domainModel.getAssociation(assocName)) {
                    await domainModel.addAssociation({
                        name: assocName,
                        parentEntity: parentEntity.$ID,
                        childEntity: groupEntity.$ID,
                        multiplicity: isResolvableArray ? 'many_to_many' : 'one_to_many',
                    });
                    associationsCreated += 1;
                }

                await populateEntityProperties(groupEntityInfo.name, groupEntity, nestedProperties, depth + 1);
                continue;
            }

            if (isArrayProperty(property)) {
                continue;
            }

            const attributeName = toModelName(propertyName);
            if (parentEntity.getAttribute(attributeName)) {
                continue;
            }

            const attributeType = getAttributeType(property as LeafProperty);
            await parentEntity.addAttribute({
                name: attributeName,
                type: attributeType,
            });
            attributesCreated += 1;
        }
    };

    // ── Group properties → associated entities ────────────────────────────────
    for (const [groupIndex, [propertyName, property]] of groupEntryList.entries()) {
        const nestedProperties = getNestedProperties(property);
        if (!nestedProperties) {
            continue;
        }

        const isResolvableArray = isArrayProperty(property);
        const preferredGroupEntityName = `${baseEntityName}_${propertyName}`;
        const groupEntityInfo = getOrCreateEntityName(domainModel, preferredGroupEntityName);

        if (groupEntityInfo.created) {
            const entity = await domainModel.addEntity({ name: groupEntityInfo.name });
            if (entity.generalization.$Type === 'DomainModels$NoGeneralization') {
                entity.generalization.persistable = false;
            }
            groupEntitiesCreated += 1;
        }

        const groupEntity = domainModel.getEntity(groupEntityInfo.name);
        if (!groupEntity) {
            throw new Error(`Failed to access generated entity '${groupEntityInfo.name}'.`);
        }

        if (groupEntityInfo.created) {
            let groupY = startY;
            for (let i = 0; i < groupIndex; i++) {
                const [, prevProp] = groupEntryList[i];
                const prevAttrCount = countDirectLeafProperties(getNestedProperties(prevProp) ?? {});
                groupY += entityHeight(prevAttrCount) + V_GAP;
            }
            groupEntity.location = { x: BASE_WIDTH + H_GAP, y: groupY };
            nextNestedEntityY = Math.max(nextNestedEntityY, groupY + entityHeight(countDirectLeafProperties(nestedProperties)) + V_GAP);
        }

        const assocName = `${baseEntityName}_${groupEntityInfo.name}`;
        if (!domainModel.getAssociation(assocName)) {
            const baseEntity = domainModel.getEntity(baseEntityName);
            if (baseEntity) {
                await domainModel.addAssociation({
                    name: assocName,
                    parentEntity: baseEntity.$ID,
                    childEntity: groupEntity.$ID,
                    multiplicity: isResolvableArray ? 'many_to_many' : 'one_to_many',
                });
                associationsCreated += 1;
            }
        }

        await populateEntityProperties(groupEntityInfo.name, groupEntity, nestedProperties, 2);
    }

    // ── Leaf properties → attributes on base entity ───────────────────────────
    for (const [propertyName, property] of Object.entries(allProperties)) {
        if (getNestedProperties(property) !== null || isArrayProperty(property)) continue;

        const baseEntity = domainModel.getEntity(baseEntityName);
        if (!baseEntity) {
            throw new Error(`Failed to access base entity '${baseEntityName}'.`);
        }

        const attributeName = toModelName(propertyName);
        if (baseEntity.getAttribute(attributeName)) continue;

        const attributeType = getAttributeType(property as LeafProperty);
        await baseEntity.addAttribute({
            name: attributeName,
            type: attributeType,
        });
        attributesCreated += 1;
    }

    await sp.app.model.domainModels.save(domainModel);

    return { baseEntityName, baseEntityCreated, groupEntitiesCreated, attributesCreated, associationsCreated };
}

async function createOrUpdateJsonStructure(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    structureName: string,
    jsonSnippet: string
): Promise<JsonStructureResult> {
    const existingStructures = await sp.app.model.jsonStructures.getUnitsInfo();
    const existingInfo = existingStructures.find(
        u => u.moduleName === moduleName && u.name === structureName
    );

    if (existingInfo) {
        const loaded = await sp.app.model.jsonStructures.loadAll(u => u.$ID === existingInfo.$ID);
        if (loaded.length > 0) {
            loaded[0].jsonSnippet = jsonSnippet;
            await sp.app.model.jsonStructures.save(loaded[0]);
            return { created: false, jsonStructureId: loaded[0].$ID };
        }
        return { created: false, jsonStructureId: existingInfo.$ID };
    }

    const created = await sp.app.model.jsonStructures.addJsonStructure(moduleId, { name: structureName, jsonSnippet });
    await sp.app.model.jsonStructures.save(created);
    return { created: true, jsonStructureId: created.$ID };
}

async function createOrUpdateImportMapping(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    mappingName: string,
    jsonStructureQualifiedName: string
): Promise<ImportMappingResult> {
    const existingMappings = await sp.app.model.importMappings.getUnitsInfo();
    const existingInfo = existingMappings.find(
        u => u.moduleName === moduleName && u.name === mappingName
    );

    if (existingInfo) {
        return { created: false, mappingId: existingInfo.$ID };
    }

    const createdMapping = await sp.app.model.importMappings.addImportMapping(moduleId, {
        name: mappingName,
        selectStructure: {
            structureType: 'jsonStructure',
            structureQualifiedName: jsonStructureQualifiedName,
            mapElements: { mappingType: 'automatic' },
        },
    });
    await sp.app.model.importMappings.save(createdMapping);
    return { created: true, mappingId: createdMapping.$ID };
}

async function createValueQueryArtifacts(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    objectType: ObjectType,
    selectedObject: { elementId: string; displayName: string },
    connection: ConnectionConfig,
    objectsValueUrl: string
): Promise<ValueQueryArtifactsResult> {
    const baseEntityName = toModelName(`${objectType.displayName}_${selectedObject.displayName}`);
    const requestBody = buildValueQueryHttpRequestBody(selectedObject.elementId.trim());
    const sampleResponse = await fetchJsonSampleResponse(sp, objectsValueUrl, connection, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: requestBody,
    });
    const latestValueSample = extractValueQueryPayload(sampleResponse.parsed);
    const normalizedSample = normalizeSampleForMapping(latestValueSample);
    const generatedObjectType = buildObjectTypeFromSample(baseEntityName, normalizedSample);
    const domainModelResult = await buildDomainModelEntities(sp, generatedObjectType, moduleName);

    const jsonStructureName = `JSON_${baseEntityName}`;
    const importMappingName = `IM_${baseEntityName}`;
    const jsonSnippet = sampleResponse.rawText;
    const jsonStructureResult = await createOrUpdateJsonStructure(
        sp,
        moduleId,
        moduleName,
        jsonStructureName,
        jsonSnippet
    );
    const importMappingResult = await createOrUpdateImportMapping(
        sp,
        moduleId,
        moduleName,
        importMappingName,
        `${moduleName}.${jsonStructureName}`
    );

    return {
        ...domainModelResult,
        jsonStructureName,
        jsonStructureCreated: jsonStructureResult.created,
        importMappingName,
        importMappingCreated: importMappingResult.created,
        importMappingId: importMappingResult.mappingId,
    };
}

async function ensureMicroflowForObject(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    microflowName: string,
    objectsUrl: string,
    connection: ConnectionConfig,
    importMappingId: string
): Promise<boolean> {
    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === moduleName && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) return false;

    const microflow = await sp.app.model.microflows.addMicroflow(moduleId, { name: microflowName });
    await populateMicroflowWithRestCall(sp, microflow, {
        url: objectsUrl,
        requestBody: '',
        connection,
        importMappingId,
    });
    await sp.app.model.microflows.save(microflow);
    return true;
}

export async function createQueryValuesMicroflow(
    objectType: ObjectType,
    selectedObject: { elementId: string; displayName: string },
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<QueryValuesMicroflowResult> {
    const sp = getStudioPro();
    const objectTypeName = toModelName(objectType.displayName);
    const objectDisplayName = toModelName(selectedObject.displayName);
    const selectedElementId = selectedObject.elementId.trim();
    const microflowName = `MF_${objectTypeName}_${objectDisplayName}`;

    if (!selectedElementId) {
        throw new Error('Selected object has no valid elementId.');
    }

    const objectsValueUrl = getObjectsValueUrl(connection.apiBaseUrl);
    if (!objectsValueUrl) {
        throw new Error(`Cannot build /objects/value URL from '${connection.apiBaseUrl}'.`);
    }

    const module = await getProjectModule(sp, moduleName);
    if (!module) {
        throw new Error(`Module '${moduleName}' was not found.`);
    }

    const artifactResult = await createValueQueryArtifacts(
        sp,
        module.$ID,
        moduleName,
        objectType,
        { elementId: selectedElementId, displayName: selectedObject.displayName },
        connection,
        objectsValueUrl
    );

    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === moduleName && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) {
        return {
            ...artifactResult,
            microflowName,
            microflowCreated: false,
        };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(module.$ID, { name: microflowName });
    await populateMicroflowWithRestCall(sp, microflow, {
        url: objectsValueUrl,
        requestBody: buildValueQueryMicroflowRequestBody(selectedElementId),
        extraHeaders: [
            { key: 'Accept', value: `'application/json'` },
            { key: 'Content-Type', value: `'application/json'` },
        ],
        connection,
        importMappingId: artifactResult.importMappingId,
    });
    await sp.app.model.microflows.save(microflow);
    return {
        ...artifactResult,
        microflowName,
        microflowCreated: true,
    };
}

export async function implementObjectAsEntity(
    selectedObject: ObjectType,
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<ImplementEntityResult> {
    const sp = getStudioPro();

    const {
        baseEntityName,
        baseEntityCreated,
        groupEntitiesCreated,
        attributesCreated,
        associationsCreated,
    } = await buildDomainModelEntities(sp, selectedObject, moduleName);

    const jsonStructureName = `JSON_${baseEntityName}`;
    const importMappingName = `IM_${baseEntityName}`;
    const microflowName = `MF_${baseEntityName}`;

    const objectTypeId = selectedObject.elementId.trim();
    const objectsUrl = objectTypeId ? getObjectsUrl(connection.apiBaseUrl, objectTypeId) : null;

    // Fetch live data for the JSON Structure snippet; fall back to the schema.
    let jsonSnippet: string;
    if (objectsUrl) {
        try {
            const proxyUrl = await sp.network.httpProxy.getProxyUrl(objectsUrl);
            const response = await fetch(proxyUrl, { headers: buildI3xRequestHeaders(connection.auth) });
            const data = response.ok ? await response.json() : selectedObject;
            jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(data), null, 2);
        } catch {
            jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(selectedObject), null, 2);
        }
    } else {
        jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(selectedObject), null, 2);
    }

    const module = await getProjectModule(sp, moduleName);
    let jsonStructureCreated = false;
    let importMappingCreated = false;
    let microflowCreated = false;
    let importMappingId: string | null = null;

    if (module) {
        const jsonStructureResult = await createOrUpdateJsonStructure(
            sp, module.$ID, moduleName, jsonStructureName, jsonSnippet
        );
        jsonStructureCreated = jsonStructureResult.created;
        const importMappingResult = await createOrUpdateImportMapping(
            sp,
            module.$ID,
            moduleName,
            importMappingName,
            `${moduleName}.${jsonStructureName}`
        );
        importMappingCreated = importMappingResult.created;
        importMappingId = importMappingResult.mappingId;
        if (objectsUrl && importMappingId) {
            microflowCreated = await ensureMicroflowForObject(
                sp,
                module.$ID,
                moduleName,
                microflowName,
                objectsUrl,
                connection,
                importMappingId
            );
        }
    }

    return {
        baseEntityName,
        baseEntityCreated,
        groupEntitiesCreated,
        attributesCreated,
        associationsCreated,
        jsonStructureName,
        jsonStructureCreated,
        importMappingName,
        importMappingCreated,
        microflowName,
        microflowCreated,
    };
}
