import type { StudioProApi } from '@mendix/extensions-api';

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
    entityName: string;
    created: boolean;
}

export async function implementObjectAsEntity(
    objectName: string,
    moduleName = 'i3X_Connector'
): Promise<ImplementEntityResult> {
    const sp = getStudioPro();
    const entityName = objectName.trim();

    if (!entityName) {
        throw new Error('Selected object has no valid name.');
    }

    const domainModel = await sp.app.model.domainModels.getDomainModel(moduleName);
    if (!domainModel) {
        throw new Error(`Module '${moduleName}' was not found or has no domain model.`);
    }

    const existingEntity = domainModel.getEntity(entityName);
    if (existingEntity) {
        return { entityName, created: false };
    }

    await domainModel.addEntity({ name: entityName });
    await sp.app.model.domainModels.save(domainModel);

    return { entityName, created: true };
}
