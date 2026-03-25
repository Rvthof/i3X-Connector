const KNOWN_SUFFIXES = [
    '/objecttypes',
    '/objects/value',
    '/objects/history',
    '/objects/list',
    '/objects/related',
    '/objects',
] as const;

function trimTrailingSlashes(path: string): string {
    return path.replace(/\/+$/, '');
}

function stripKnownSuffix(path: string): string {
    let current = trimTrailingSlashes(path);
    for (const suffix of KNOWN_SUFFIXES) {
        const suffixRegex = new RegExp(`${suffix.replace('/', '\\/')}$`, 'i');
        if (suffixRegex.test(current)) {
            current = current.replace(suffixRegex, '');
            break;
        }
    }
    return current;
}

function toNormalizedPath(path: string): string {
    const stripped = stripKnownSuffix(path);
    const withoutTrailing = trimTrailingSlashes(stripped);
    const withI3x = /\/i3x$/i.test(withoutTrailing)
        ? withoutTrailing
        : `${withoutTrailing}/i3x`;
    return withI3x.replace(/\/{2,}/g, '/') || '/i3x';
}

export function normalizeI3xBaseUrl(inputUrl: string): string | null {
    try {
        const parsed = new URL(inputUrl.trim());
        parsed.pathname = toNormalizedPath(parsed.pathname);
        parsed.search = '';
        parsed.hash = '';
        return `${trimTrailingSlashes(parsed.toString())}/`;
    } catch {
        return null;
    }
}

function buildFromBase(apiBaseUrl: string, endpointPath: string): URL | null {
    const normalizedBase = normalizeI3xBaseUrl(apiBaseUrl);
    if (!normalizedBase) {
        return null;
    }

    const parsed = new URL(normalizedBase);
    const basePath = trimTrailingSlashes(parsed.pathname);
    parsed.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/g, '/');
    parsed.search = '';
    parsed.hash = '';
    return parsed;
}

export function getObjectTypesUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '/objecttypes')?.toString() ?? null;
}

export function getObjectsUrl(apiBaseUrl: string, typeId: string): string | null {
    const parsed = buildFromBase(apiBaseUrl, '/objects');
    if (!parsed) {
        return null;
    }
    parsed.searchParams.set('typeId', typeId);
    return parsed.toString();
}

export function getObjectsValueUrl(apiBaseUrl: string): string | null {
    return buildFromBase(apiBaseUrl, '/objects/value')?.toString() ?? null;
}