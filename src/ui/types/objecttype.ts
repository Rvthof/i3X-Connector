export interface LeafProperty {
    type?: string;
    format?: string;
    minimum?: number;
    maximum?: number;
    default?: unknown;
    maxLength?: number;
    [key: string]: unknown;
}

export interface GroupProperty {
    type: 'object';
    properties: Record<string, LeafProperty>;
    required: string[];
    additionalProperties: boolean;
    $defs: Record<string, unknown>;
}

export type AnyProperty = LeafProperty | GroupProperty;

export interface ObjectTypeSchema {
    type: string;
    description?: string;
    properties?: Record<string, AnyProperty>;
    required?: string[];
    additionalProperties?: boolean;
    [key: string]: unknown;
}

export interface ObjectType {
    elementId: string;
    displayName: string;
    namespaceUri: string;
    schema: ObjectTypeSchema;
    [key: string]: unknown;
}

export function isGroupProperty(p: AnyProperty): p is GroupProperty {
    return p.type === 'object' && 'properties' in p && typeof p.properties === 'object';
}

export function isObjectTypeArray(value: unknown): value is ObjectType[] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                'elementId' in item &&
                'displayName' in item &&
                'namespaceUri' in item
        )
    );
}
