import type { StudioProApi } from '@mendix/extensions-api';
import type { DomainModels } from '@mendix/extensions-api';
import type { Microflows } from '@mendix/extensions-api';
import type { Texts } from '@mendix/extensions-api';
import { isGroupProperty, isArrayProperty, extractArrayItemProperties, type ConnectionConfig, type LeafProperty, type ObjectType } from '../types';
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
    microflowName: string;
    microflowCreated: boolean;
}

type MendixAttributeType = NonNullable<DomainModels.AttributeCreationOptions['type']>;
const MENDIX_LONG_MIN = Number('-9223372036854775808');
const MENDIX_LONG_MAX = Number('9223372036854775807');

function toModelName(raw: string): string {
    const compact = raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
    const startsWithLetter = /^[A-Za-z]/.test(compact) ? compact : `N_${compact}`;
    return startsWithLetter || 'Unnamed';
}

function getAttributeType(property: LeafProperty): MendixAttributeType | undefined {
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

    return undefined;
}

function clampToMendixLong(value: number): number {
    if (!Number.isFinite(value)) {
        return value;
    }
    if (value < MENDIX_LONG_MIN) {
        return MENDIX_LONG_MIN;
    }
    if (value > MENDIX_LONG_MAX) {
        return MENDIX_LONG_MAX;
    }
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

async function ensureMicroflowForObject(
    sp: StudioProApi,
    moduleId: string,
    moduleName: string,
    microflowName: string,
    objectsUrl: string,
    connection: ConnectionConfig
): Promise<boolean> {
    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === moduleName && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) {
        return false;
    }

    const microflow = await sp.app.model.microflows.addMicroflow(moduleId, { name: microflowName });
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

    requestTemplate.text = '';
    requestHandler.template = requestTemplate;
    restCall.requestHandling = requestHandler;
    restCall.requestHandlingType = 'Custom';

    httpConfiguration.overrideLocation = true;
    locationTemplate.text = '{1}';
    locationTemplateArg.expression = `'${objectsUrl}'`;
    locationTemplate.arguments = [locationTemplateArg];
    httpConfiguration.customLocationTemplate = locationTemplate;
    await configureHttpAuthForMicroflow(sp, httpConfiguration, connection.auth);
    restCall.httpConfiguration = httpConfiguration;

    resultHandling.storeInVariable = true;
    resultHandling.outputVariableName = 'ResponseBody';
    resultHandling.variableType = stringType as typeof resultHandling.variableType;
    restCall.resultHandling = resultHandling;
    restCall.resultHandlingType = 'String';
    restCall.errorResultHandlingType = 'None';

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
        'Successfully received response from i3X API. Response: {1}',
        ['$ResponseBody'],
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

    const module = await sp.app.model.projects.getModule(moduleName);
    if (!module) {
        throw new Error(`Module '${moduleName}' was not found.`);
    }

    const existingMicroflows = await sp.app.model.microflows.loadAll(
        unitInfo => unitInfo.moduleName === moduleName && unitInfo.name === microflowName,
        1
    );
    if (existingMicroflows.length > 0) {
        return { microflowName, microflowCreated: false };
    }

    const microflow = await sp.app.model.microflows.addMicroflow(module.$ID, { name: microflowName });
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

    requestTemplate.text = `{{\n  "elementIds": [\n    "${selectedElementId}"\n  ],\n  "maxDepth": 1\n}`;
    requestHandler.template = requestTemplate;
    restCall.requestHandling = requestHandler;
    restCall.requestHandlingType = 'Custom';

    httpConfiguration.overrideLocation = true;
    locationTemplate.text = '{1}';
    locationTemplateArg.expression = `'${objectsValueUrl}'`;
    locationTemplate.arguments = [locationTemplateArg];
    httpConfiguration.customLocationTemplate = locationTemplate;
    await configureHttpAuthForMicroflow(sp, httpConfiguration, connection.auth);

    // /objects/value expects JSON payload; include explicit headers for reliable POST handling.
    const acceptHeader = (await sp.app.model.microflows.createElement(
        'Microflows$HttpHeaderEntry'
    )) as Microflows.HttpHeaderEntry;
    acceptHeader.key = 'Accept';
    acceptHeader.value = 'application/json';
    httpConfiguration.headerEntries.push(acceptHeader);
    
    const contentTypeHeader = (await sp.app.model.microflows.createElement(
        'Microflows$HttpHeaderEntry'
    )) as Microflows.HttpHeaderEntry;
    contentTypeHeader.key = 'Content-Type';
    contentTypeHeader.value = 'application/json';
    httpConfiguration.headerEntries.push(contentTypeHeader);

    restCall.httpConfiguration = httpConfiguration;

    resultHandling.storeInVariable = true;
    resultHandling.outputVariableName = 'ResponseBody';
    resultHandling.variableType = stringType as typeof resultHandling.variableType;
    restCall.resultHandling = resultHandling;
    restCall.resultHandlingType = 'String';
    restCall.errorResultHandlingType = 'None';

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
        'Successfully received response from i3X API. Response: {1}',
        ['$ResponseBody'],
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

    await sp.app.model.microflows.save(microflow);
    return { microflowName, microflowCreated: true };
}

export async function implementObjectAsEntity(
    selectedObject: ObjectType,
    connection: ConnectionConfig,
    moduleName = 'i3X_Connector'
): Promise<ImplementEntityResult> {
    const sp = getStudioPro();
    const baseEntityName = toModelName(selectedObject.displayName);

    if (!baseEntityName) {
        throw new Error('Selected object has no valid name.');
    }

    const domainModel = await sp.app.model.domainModels.getDomainModel(moduleName);
    if (!domainModel) {
        throw new Error(`Module '${moduleName}' was not found or has no domain model.`);
    }

    // ── Layout constants ─────────────────────────────────────────────────────
    // Base entity sits on the left; group entities fan out in a column to the right.
    // Heights grow with attribute count: header (~30px) + ~20px per attribute.
    const ATTR_ROW_H    = 20;    // px per attribute row
    const ENTITY_HDR_H  = 30;    // px for entity header
    const H_GAP         = 80;    // horizontal gap between base and group column
    const V_GAP         = 40;    // vertical gap between group entities
    const BASE_WIDTH    = 200;   // base entity column width

    function entityHeight(attrCount: number): number {
        return ENTITY_HDR_H + Math.max(1, attrCount) * ATTR_ROW_H;
    }

    // Count attributes per entity upfront so we can compute layout before creation.
    const allProperties = selectedObject.schema.properties ?? {};

    // Both object-type groups and array-type groups become associated entities.
    const groupEntryList = Object.entries(allProperties).filter(([, p]) =>
        isGroupProperty(p) || (isArrayProperty(p) && extractArrayItemProperties(p) !== null)
    );
    const leafCount = Object.entries(allProperties).filter(
        ([, p]) => !isGroupProperty(p) && !isArrayProperty(p)
    ).length;
    const baseHeight = entityHeight(leafCount);

    // Pick a starting Y below the lowest existing entity to avoid overlap.
    let startY = 0;
    for (const ent of domainModel.entities) {
        const bottom = ent.location.y + ENTITY_HDR_H + ATTR_ROW_H + V_GAP;
        if (bottom > startY) startY = bottom;
    }

    // Centre the base entity vertically against the group column.
    const groupColumnHeight = groupEntryList.reduce((sum, [, p]) => {
        const attrCount = isGroupProperty(p)
            ? Object.keys(p.properties ?? {}).length
            : Object.keys(extractArrayItemProperties(p as never) ?? {}).length;
        return sum + entityHeight(attrCount) + V_GAP;
    }, -V_GAP); // subtract one trailing gap
    const baseY = startY + Math.max(0, (groupColumnHeight - baseHeight) / 2);

    let baseEntityCreated = false;
    if (!domainModel.getEntity(baseEntityName)) {
        await domainModel.addEntity({ name: baseEntityName });
        baseEntityCreated = true;
    }

    // Position the base entity.
    const baseEntityObj = domainModel.getEntity(baseEntityName);
    if (baseEntityObj && baseEntityCreated) {
        baseEntityObj.location = { x: 0, y: baseY };
    }

    const properties = selectedObject.schema.properties ?? {};
    let groupEntitiesCreated = 0;
    let attributesCreated = 0;
    let associationsCreated = 0;
    let groupIndex = 0;

    for (const [propertyName, property] of Object.entries(properties)) {
        const isResolvableArray = isArrayProperty(property) && extractArrayItemProperties(property) !== null;
        if (isGroupProperty(property) || isResolvableArray) {
            const preferredGroupEntityName = `${baseEntityName}_${propertyName}`;
            const groupEntityInfo = getOrCreateEntityName(domainModel, preferredGroupEntityName);

            if (groupEntityInfo.created) {
                await domainModel.addEntity({ name: groupEntityInfo.name });
                groupEntitiesCreated += 1;
            }

            const groupEntity = domainModel.getEntity(groupEntityInfo.name);
            if (!groupEntity) {
                throw new Error(`Failed to access generated entity '${groupEntityInfo.name}'.`);
            }

            // Position new group entity to the right of the base entity.
            if (groupEntityInfo.created) {
                // Compute Y by summing heights of all preceding group entities.
                let groupY = startY;
                for (let i = 0; i < groupIndex; i++) {
                    const [, prevProp] = groupEntryList[i];
                    const prevAttrCount = isGroupProperty(prevProp)
                        ? Object.keys((prevProp as { properties?: Record<string, unknown> }).properties ?? {}).length
                        : Object.keys(extractArrayItemProperties(prevProp as never) ?? {}).length;
                    groupY += entityHeight(prevAttrCount) + V_GAP;
                }
                groupEntity.location = { x: BASE_WIDTH + H_GAP, y: groupY };
            }
            groupIndex += 1;

            // Arrays get many-to-many (a list of items); objects get one-to-many.
            const isArray = isArrayProperty(property);
            const assocName = `${baseEntityName}_${groupEntityInfo.name}`;
            if (!domainModel.getAssociation(assocName)) {
                const baseEntity = domainModel.getEntity(baseEntityName);
                if (baseEntity) {
                    await domainModel.addAssociation({
                        name: assocName,
                        parentEntity: baseEntity.$ID,
                        childEntity: groupEntity.$ID,
                        multiplicity: isArray ? 'many_to_many' : 'one_to_many',
                    });
                    associationsCreated += 1;
                }
            }

            // Resolve the leaf properties to add as attributes.
            const leafProperties = isGroupProperty(property)
                ? property.properties
                : (extractArrayItemProperties(property) ?? {});

            for (const [leafName, leafProperty] of Object.entries(leafProperties)) {
                const attributeName = toModelName(leafName);
                if (groupEntity.getAttribute(attributeName)) {
                    continue;
                }

                const attributeType = getAttributeType(leafProperty);
                const attributeOptions: DomainModels.AttributeCreationOptions = {
                    name: attributeName,
                    ...(attributeType ? { type: attributeType } : {}),
                };

                await groupEntity.addAttribute(attributeOptions);
                attributesCreated += 1;
            }
            continue;
        }

        // Skip array properties with no resolvable item schema — nothing to map.
        if (isArrayProperty(property)) {
            continue;
        }

        const baseEntity = domainModel.getEntity(baseEntityName);
        if (!baseEntity) {
            throw new Error(`Failed to access base entity '${baseEntityName}'.`);
        }

        const attributeName = toModelName(propertyName);
        if (baseEntity.getAttribute(attributeName)) {
            continue;
        }

        const attributeType = getAttributeType(property);
        const attributeOptions: DomainModels.AttributeCreationOptions = {
            name: attributeName,
            ...(attributeType ? { type: attributeType } : {}),
        };

        await baseEntity.addAttribute(attributeOptions);
        attributesCreated += 1;
    }

    await sp.app.model.domainModels.save(domainModel);

    // ── JSON Structure ───────────────────────────────────────────────────────
    // Fetch /objects?typeId=<elementId> using the user-supplied i3X base URL,
    // then store the result as the JSON Structure snippet.
    const jsonStructureName = `JSON_${baseEntityName}`;
    const importMappingName = `IM_${baseEntityName}`;
    const microflowName = `MF_${baseEntityName}`;
    let jsonStructureCreated = false;
    let importMappingCreated = false;
    let microflowCreated = false;

    // Derive the objects endpoint from base /i3x/ and append typeId.
    const objectTypeId = selectedObject.elementId.trim();
    const objectsUrl = objectTypeId ? getObjectsUrl(connection.apiBaseUrl, objectTypeId) : null;

    let jsonSnippet: string;
    if (objectsUrl) {
        try {
            const proxyUrl = await sp.network.httpProxy.getProxyUrl(objectsUrl);
            const response = await fetch(proxyUrl, { headers: buildI3xRequestHeaders(connection.auth) });
            if (response.ok) {
                const data = await response.json();
                jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(data), null, 2);
            } else {
                // Fall back to the schema if the objects endpoint fails.
                jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(selectedObject), null, 2);
            }
        } catch {
            jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(selectedObject), null, 2);
        }
    } else {
        jsonSnippet = JSON.stringify(sanitizeJsonForMendixLimits(selectedObject), null, 2);
    }

    const module = await sp.app.model.projects.getModule(moduleName);
    if (module) {
        // ── JSON Structure ────────────────────────────────────────────
        const existingStructures = await sp.app.model.jsonStructures.getUnitsInfo();
        const existingJsonInfo = existingStructures.find(
            u => u.moduleName === moduleName && u.name === jsonStructureName
        );

        if (existingJsonInfo) {
            // Already exists — update the snippet to reflect the latest data.
            const loaded = await sp.app.model.jsonStructures.loadAll(
                u => u.$ID === existingJsonInfo.$ID
            );
            if (loaded.length > 0) {
                loaded[0].jsonSnippet = jsonSnippet;
                await sp.app.model.jsonStructures.save(loaded[0]);
            }
        } else {
            // New — create with the snippet pre-populated.
            await sp.app.model.jsonStructures.addJsonStructure(
                module.$ID,
                { name: jsonStructureName, jsonSnippet }
            );
            jsonStructureCreated = true;
        }

        // ── Import Mapping ────────────────────────────────────────
        const jsonStructureQualifiedName = `${moduleName}.${jsonStructureName}`;
        const existingMappings = await sp.app.model.importMappings.getUnitsInfo();
        const existingMappingInfo = existingMappings.find(
            u => u.moduleName === moduleName && u.name === importMappingName
        );

        if (!existingMappingInfo) {
            const mapping = await sp.app.model.importMappings.addImportMapping(
                module.$ID,
                {
                    name: importMappingName,
                    selectStructure: {
                        structureType: 'jsonStructure',
                        structureQualifiedName: jsonStructureQualifiedName,
                        mapElements: { mappingType: 'automatic' },
                    },
                }
            );
            importMappingCreated = true;
        }

        if (objectsUrl) {
            microflowCreated = await ensureMicroflowForObject(
                sp,
                module.$ID,
                moduleName,
                microflowName,
                objectsUrl,
                connection
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
