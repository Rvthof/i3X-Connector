import React, { useEffect, useMemo, useState } from 'react';
import { ComponentContext, getStudioProApi } from '@mendix/extensions-api';
import styles from '../index.module.css';
import { ObjectType, AnyProperty, ConnectionConfig, isGroupProperty, isArrayProperty, extractArrayItemProperties } from '../types';
import { createQueryValuesMicroflow } from '../services/studioProService';
import { getObjectsUrl } from '../services/i3xUrl';
import { buildI3xRequestHeaders } from '../services/auth';

function shortNs(uri: string): string {
    return uri.split('/').filter(Boolean).pop() ?? uri;
}

interface Props {
    context: ComponentContext;
    connection: ConnectionConfig;
    item: ObjectType;
    onClose: () => void;
    onImplement: (item: ObjectType) => Promise<void>;
}

// ─── Constraint pills ─────────────────────────────────────────────────────────

const FLOAT_MAX = 1.7976931348623157e308;
const INT_MAX   = 9223372036854775807;

function formatConstraint(key: string, value: unknown): string | null {
    if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') return null;
    if (typeof value === 'number') {
        if (Math.abs(value) >= FLOAT_MAX * 0.999 || Math.abs(value) >= INT_MAX * 0.999) return null;
    }
    const labels: Record<string, string> = {
        minimum: 'min', maximum: 'max', maxLength: 'maxLen',
        default: 'default', format: 'format',
    };
    const label = labels[key] ?? key;
    return `${label}: ${value}`;
}

const ConstraintPills: React.FC<{ prop: AnyProperty }> = ({ prop }) => {
    const constraintKeys = ['minimum', 'maximum', 'maxLength', 'default', 'format'];
    const pills = constraintKeys
        .map(k => formatConstraint(k, (prop as Record<string, unknown>)[k]))
        .filter((v): v is string => v !== null);

    if (pills.length === 0) return null;
    return (
        <span className={styles.constraintList}>
            {pills.map(p => <span key={p} className={styles.constraintPill}>{p}</span>)}
        </span>
    );
};

// ─── Type badge ───────────────────────────────────────────────────────────────

const TypeBadge: React.FC<{ prop: AnyProperty }> = ({ prop }) => {
    if (!prop.type) return <span className={styles.unknownBadge}>unknown</span>;
    if (prop.type === 'array') return <span className={styles.arrayBadge}>array</span>;
    return <span className={styles.typeBadge}>{prop.type}</span>;
};

// ─── Leaf property row ────────────────────────────────────────────────────────

const LeafRow: React.FC<{ name: string; prop: AnyProperty; required: boolean; indent?: boolean }> = ({ name, prop, required, indent }) => (
    <tr className={styles.propRow}>
        <td className={styles.propNameCell}>
            {indent && <span className={styles.indent} />}
            <span className={styles.propName}>{name}</span>
        </td>
        <td className={styles.tableCell}>
            <TypeBadge prop={prop} />
        </td>
        <td className={styles.tableCell}>
            {required
                ? <span className={styles.requiredBadge}>required</span>
                : <span className={styles.textFaint}>optional</span>}
        </td>
        <td className={styles.tableCell}>
            <ConstraintPills prop={prop} />
        </td>
    </tr>
);

// ─── Array section (collapsible) ─────────────────────────────────────────────

const ArraySection: React.FC<{ name: string; prop: AnyProperty; isRequired: boolean }> = ({ name, prop, isRequired }) => {
    const [open, setOpen] = useState(true);

    if (!isArrayProperty(prop)) return null;
    const itemProps = extractArrayItemProperties(prop);

    return (
        <>
            <tr
                className={`${styles.propRow} ${styles.groupRow}`}
                onClick={() => setOpen(o => !o)}
            >
                <td className={styles.propNameCell} colSpan={4}>
                    <span className={styles.groupChevron}>{open ? '▾' : '▸'}</span>
                    <span className={styles.groupName}>{name}</span>
                    <span className={styles.arrayBadge} style={{ marginLeft: 6 }}>array</span>
                    {itemProps
                        ? <span className={styles.groupCount}>{Object.keys(itemProps).length} fields → entity</span>
                        : <span className={styles.groupCount}>no resolvable item schema</span>}
                    {isRequired && <span className={`${styles.requiredBadge} ${styles.groupRequiredBadge}`}>required</span>}
                </td>
            </tr>
            {open && itemProps && Object.entries(itemProps).map(([leafName, leafProp]) => (
                <tr key={leafName} className={`${styles.propRow} ${styles.propRowNested}`}>
                    <td className={styles.propNameCell}>
                        <span className={styles.indent} />
                        <span className={styles.propName}>{leafName}</span>
                    </td>
                    <td className={styles.tableCell}><TypeBadge prop={leafProp} /></td>
                    <td className={styles.tableCell}><span className={styles.textFaint}>optional</span></td>
                    <td className={styles.tableCell}><ConstraintPills prop={leafProp} /></td>
                </tr>
            ))}
        </>
    );
};

// ─── Group section (collapsible) ──────────────────────────────────────────────

const GroupSection: React.FC<{ name: string; prop: AnyProperty; topRequired: string[] }> = ({ name, prop, topRequired }) => {
    const [open, setOpen] = useState(true);
    const isRequired = topRequired.includes(name);

    if (isArrayProperty(prop)) {
        return <ArraySection name={name} prop={prop} isRequired={isRequired} />;
    }

    if (!isGroupProperty(prop)) {
        return <LeafRow name={name} prop={prop} required={isRequired} />;
    }

    const leafEntries = Object.entries(prop.properties ?? {});
    const groupRequired = prop.required ?? [];

    return (
        <>
            <tr
                className={`${styles.propRow} ${styles.groupRow}`}
                onClick={() => setOpen(o => !o)}
            >
                <td className={styles.propNameCell} colSpan={4}>
                    <span className={styles.groupChevron}>{open ? '▾' : '▸'}</span>
                    <span className={styles.groupName}>{name}</span>
                    <span className={styles.groupCount}>{leafEntries.length} fields</span>
                    {isRequired && <span className={`${styles.requiredBadge} ${styles.groupRequiredBadge}`}>required</span>}
                </td>
            </tr>
            {open && leafEntries.map(([leafName, leafProp]) => (
                <tr key={leafName} className={`${styles.propRow} ${styles.propRowNested}`}>
                    <td className={styles.propNameCell}>
                        <span className={styles.indent} />
                        <span className={styles.propName}>{leafName}</span>
                    </td>
                    <td className={styles.tableCell}><TypeBadge prop={leafProp} /></td>
                    <td className={styles.tableCell}>
                        {groupRequired.includes(leafName)
                            ? <span className={styles.requiredBadge}>required</span>
                            : <span className={styles.textFaint}>optional</span>}
                    </td>
                    <td className={styles.tableCell}><ConstraintPills prop={leafProp} /></td>
                </tr>
            ))}
        </>
    );
};

function flattenObjectToColumns(
    value: unknown,
    prefix = '',
    out: Record<string, string> = {}
): Record<string, string> {
    if (value === null || value === undefined) {
        if (prefix) out[prefix] = '—';
        return out;
    }

    if (Array.isArray(value)) {
        if (prefix) out[prefix] = JSON.stringify(value);
        return out;
    }

    if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            const nextPrefix = prefix ? `${prefix}.${key}` : key;
            flattenObjectToColumns(child, nextPrefix, out);
        }
        return out;
    }

    if (prefix) {
        out[prefix] = String(value);
    }
    return out;
}

// ─── Main component ───────────────────────────────────────────────────────────

const DetailPanel: React.FC<Props> = ({ context, connection, item, onClose, onImplement }) => {
    const studioPro = getStudioProApi(context);
    const [isImplementing, setIsImplementing] = useState(false);
    const [activeTab, setActiveTab] = useState<'attributes' | 'objects'>('attributes');
    const [isLoadingObjects, setIsLoadingObjects] = useState(true);
    const [isCreatingQuery, setIsCreatingQuery] = useState(false);
    const [retrievedObjects, setRetrievedObjects] = useState<unknown[]>([]);
    const [objectsLoadError, setObjectsLoadError] = useState<string | null>(null);
    const [selectedObjectIndex, setSelectedObjectIndex] = useState<number | null>(null);
    const schema = item.schema;
    const properties = schema.properties ?? {};
    const topRequired = schema.required ?? [];
    const entries = Object.entries(properties);

    const totalLeafs = entries.reduce((acc, [, prop]) => {
        if (isGroupProperty(prop)) return acc + Object.keys(prop.properties ?? {}).length;
        if (isArrayProperty(prop)) {
            const itemProps = extractArrayItemProperties(prop);
            return acc + (itemProps ? Object.keys(itemProps).length : 0);
        }
        return acc + 1;
    }, 0);

    const flattenedObjects = useMemo(
        () => retrievedObjects.map(obj => flattenObjectToColumns(obj)),
        [retrievedObjects]
    );
    const objectColumns = useMemo(
        () =>
            Array.from(new Set(flattenedObjects.flatMap(obj => Object.keys(obj))))
                .filter(column => {
                    const lastSegment = column.split('.').pop()?.toLowerCase() ?? '';
                    return lastSegment !== 'typeid' && lastSegment !== 'namespaceuri';
                }),
        [flattenedObjects]
    );
    const isElementIdColumn = (column: string) =>
        (column.split('.').pop()?.toLowerCase() ?? '') === 'elementid';

    const handleImplement = async () => {
        if (isImplementing) return;
        setIsImplementing(true);
        try {
            await onImplement(item);
        } finally {
            setIsImplementing(false);
        }
    };

    useEffect(() => {
        let cancelled = false;

        const loadObjects = async () => {
            setIsLoadingObjects(true);
            setObjectsLoadError(null);
            setRetrievedObjects([]);
            setSelectedObjectIndex(null);

            const objectsUrl = getObjectsUrl(connection.apiBaseUrl, item.elementId);
            if (!objectsUrl) {
                if (!cancelled) {
                    setObjectsLoadError(`Cannot build objects URL from '${connection.apiBaseUrl}'.`);
                    setIsLoadingObjects(false);
                }
                return;
            }

            try {
                const proxy = await studioPro.network.httpProxy.getProxyUrl(objectsUrl);
                const response = await fetch(proxy, { headers: buildI3xRequestHeaders(connection.auth) });
                if (!response.ok) {
                    if (!cancelled) {
                        setObjectsLoadError(`Status: ${response.status}`);
                    }
                    return;
                }

                const data = await response.json();
                const objects = Array.isArray(data) ? data : [data];
                if (!cancelled) {
                    setRetrievedObjects(objects);
                    setSelectedObjectIndex(objects.length > 0 ? 0 : null);
                }
            } catch (error) {
                if (!cancelled) {
                    setObjectsLoadError(error instanceof Error ? error.message : String(error));
                }
            } finally {
                if (!cancelled) {
                    setIsLoadingObjects(false);
                }
            }
        };

        setActiveTab('attributes');
        void loadObjects();

        return () => {
            cancelled = true;
        };
    }, [connection, item.elementId, studioPro.network.httpProxy]);

    const handleCreateValueQuery = async () => {
        if (selectedObjectIndex === null || isCreatingQuery) return;

        const selected = retrievedObjects[selectedObjectIndex];
        if (!selected || typeof selected !== 'object') {
            await studioPro.ui.messageBoxes.show('error', 'Invalid selected object', 'Could not read selected object data.');
            return;
        }

        const selectedRecord = selected as Record<string, unknown>;
        const findField = (fieldName: string): unknown =>
            Object.entries(selectedRecord).find(([k]) => k.toLowerCase() === fieldName.toLowerCase())?.[1];

        const elementIdValue = findField('elementId');
        if (typeof elementIdValue !== 'string' || !elementIdValue.trim()) {
            await studioPro.ui.messageBoxes.show('error', 'Missing elementId', 'Selected object does not contain a valid elementId.');
            return;
        }

        const rawDisplayName = findField('displayName');
        const displayNameValue =
            typeof rawDisplayName === 'string' && rawDisplayName.trim()
                ? rawDisplayName
                : elementIdValue;

        setIsCreatingQuery(true);
        try {
            const result = await createQueryValuesMicroflow(
                item,
                { elementId: elementIdValue, displayName: displayNameValue },
                connection,
                'i3X_Connector'
            );
            const somethingCreated =
                result.baseEntityCreated ||
                result.groupEntitiesCreated > 0 ||
                result.attributesCreated > 0 ||
                result.associationsCreated > 0 ||
                result.jsonStructureCreated ||
                result.importMappingCreated ||
                result.microflowCreated;

            const parts = [
                `Base '${result.baseEntityName}'`,
                `Group entities: ${result.groupEntitiesCreated}`,
                `Attributes: ${result.attributesCreated}`,
                `Associations: ${result.associationsCreated}`,
                `JSON Structure '${result.jsonStructureName}' ${
                    result.jsonStructureCreated ? 'created' : 'updated'
                }`,
                `Import Mapping '${result.importMappingName}' ${
                    result.importMappingCreated ? 'created' : 'already exists'
                }`,
                `Microflow '${result.microflowName}' ${
                    result.microflowCreated ? 'created' : 'already exists'
                }`,
            ];

            await studioPro.ui.notifications.show({
                title: somethingCreated ? 'Value query artifacts prepared' : 'Value query artifacts already exist',
                message: parts.join(' | '),
                displayDurationInSeconds: 6,
            });
        } catch (error) {
            const details = error instanceof Error ? error.message : String(error);
            await studioPro.ui.messageBoxes.show('error', 'Could not create value query microflow', details);
        } finally {
            setIsCreatingQuery(false);
        }
    };

    return (
        <div className={styles.detailPanel}>
            {/* Header */}
            <div className={styles.detailHeader}>
                <div>
                    <h2 className={styles.detailTitle}>{item.displayName}</h2>
                    <span className={styles.idCell}>{item.elementId}</span>
                </div>
                <div className={styles.detailHeaderActions}>
                    <button
                        className={styles.implementButton}
                        onClick={handleImplement}
                        disabled={isImplementing}
                    >
                        {isImplementing ? 'Implementing...' : 'Implement'}
                    </button>
                    <button className={styles.closeButton} onClick={onClose} title="Close">✕</button>
                </div>
            </div>

            {/* Meta bar */}
            <div className={styles.detailMeta}>
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Namespace</span>
                    <span className={styles.nsBadge}>{shortNs(item.namespaceUri)}</span>
                </div>
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>URI</span>
                    <span className={styles.metaValue}>{item.namespaceUri}</span>
                </div>
                {schema.type && (
                    <div className={styles.metaItem}>
                        <span className={styles.metaLabel}>Schema type</span>
                        <span className={styles.typeBadge}>{schema.type}</span>
                    </div>
                )}
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Groups</span>
                    <span className={styles.metaValue}>{entries.length}</span>
                </div>
                <div className={styles.metaItem}>
                    <span className={styles.metaLabel}>Total fields</span>
                    <span className={styles.metaValue}>{totalLeafs}</span>
                </div>
            </div>

            {schema.description && (
                <p className={styles.detailDescription}>{schema.description}</p>
            )}

            <div className={styles.detailTabs}>
                <button
                    className={`${styles.detailTabButton} ${activeTab === 'attributes' ? styles.detailTabButtonActive : ''}`}
                    onClick={() => setActiveTab('attributes')}
                >
                    Attributes
                </button>
                <button
                    className={`${styles.detailTabButton} ${activeTab === 'objects' ? styles.detailTabButtonActive : ''}`}
                    onClick={() => setActiveTab('objects')}
                >
                    Objects
                </button>
            </div>

            {/* Properties or retrieved objects */}
            {activeTab === 'objects' ? (
                <div className={styles.detailSection}>
                    {isLoadingObjects ? (
                        <p className={styles.noPropsMessage}>Loading objects...</p>
                    ) : objectsLoadError ? (
                        <p className={styles.noPropsMessage}>Could not load objects: {objectsLoadError}</p>
                    ) : retrievedObjects.length === 0 ? (
                        <p className={styles.noPropsMessage}>No objects returned for this type.</p>
                    ) : (
                        <>
                            <table className={styles.pipelineTable}>
                                <thead>
                                    <tr className={styles.tableHeader}>
                                        <th className={`${styles.tableHeaderCell} ${styles.rowNumberCell}`}>#</th>
                                        {objectColumns.map(column => (
                                            <th
                                                key={column}
                                                className={`${styles.tableHeaderCell} ${isElementIdColumn(column) ? styles.elementIdCell : ''}`}
                                            >
                                                {column}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {flattenedObjects.map((obj, index) => (
                                        <tr
                                            key={index}
                                            onClick={() => setSelectedObjectIndex(index)}
                                            className={`${styles.tableRow} ${selectedObjectIndex === index ? styles.selected : ''}`}
                                        >
                                            <td className={`${styles.tableCell} ${styles.rowNumberCell}`}>{index + 1}</td>
                                            {objectColumns.map(column => {
                                                const cellValue = obj[column] ?? '—';
                                                const valueText = String(cellValue);
                                                return (
                                                    <td
                                                        key={column}
                                                        className={`${styles.tableCell} ${styles.descCell} ${isElementIdColumn(column) ? styles.elementIdCell : ''}`}
                                                        title={valueText}
                                                    >
                                                        {valueText}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className={styles.objectActions}>
                                <button
                                    className={styles.implementButton}
                                    onClick={handleCreateValueQuery}
                                    disabled={selectedObjectIndex === null || isCreatingQuery}
                                >
                                    {isCreatingQuery ? 'Creating query...' : 'Create last-known-value query microflow'}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            ) : entries.length > 0 ? (
                <div className={styles.detailSection}>
                    <table className={styles.propTable}>
                        <thead>
                            <tr className={styles.tableHeader}>
                                <th className={styles.tableHeaderCell} style={{ width: '32%' }}>Property</th>
                                <th className={styles.tableHeaderCell} style={{ width: '14%' }}>Type</th>
                                <th className={styles.tableHeaderCell} style={{ width: '14%' }}>Required</th>
                                <th className={styles.tableHeaderCell} style={{ width: '40%' }}>Constraints</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.map(([name, prop]) => (
                                <GroupSection
                                    key={name}
                                    name={name}
                                    prop={prop}
                                    topRequired={topRequired}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <p className={styles.noPropsMessage}>
                    This type has no properties defined — it is a scalar or metadata-only type.
                </p>
            )}
        </div>
    );
};

export default DetailPanel;
