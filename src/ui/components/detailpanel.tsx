import React, { useState } from 'react';
import styles from '../index.module.css';
import { ObjectType, AnyProperty, isGroupProperty, isArrayProperty, extractArrayItemProperties } from '../types';

interface Props {
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

// ─── Main component ───────────────────────────────────────────────────────────

const DetailPanel: React.FC<Props> = ({ item, onClose, onImplement }) => {
    const [isImplementing, setIsImplementing] = useState(false);
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

    const shortNs = (uri: string) => uri.split('/').filter(Boolean).pop() ?? uri;

    const handleImplement = async () => {
        if (isImplementing) return;
        setIsImplementing(true);
        try {
            await onImplement(item);
        } finally {
            setIsImplementing(false);
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

            {/* Properties */}
            {entries.length > 0 ? (
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
