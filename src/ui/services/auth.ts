import type { AuthConfig } from '../types';
import type { StudioProApi } from '@mendix/extensions-api';
import type { Microflows } from '@mendix/extensions-api';

function toBase64(value: string): string {
    return btoa(value);
}

function buildAuthHeaderValue(auth: AuthConfig): { key: string; value: string } | null {
    if (auth.mode === 'none') {
        return null;
    }

    if (auth.mode === 'basic') {
        const basicToken = toBase64(`${auth.username}:${auth.password}`);
        return { key: 'Authorization', value: `Basic ${basicToken}` };
    }

    const tokenValue = auth.prefix ? `${auth.prefix.trim()} ${auth.token}`.trim() : auth.token;
    const headerName = auth.headerName.trim() || 'Authorization';
    return { key: headerName, value: tokenValue };
}

export function buildI3xRequestHeaders(auth: AuthConfig): Record<string, string> {
    const headers: Record<string, string> = {
        accept: 'application/json',
    };

    const authHeader = buildAuthHeaderValue(auth);
    if (authHeader) {
        headers[authHeader.key] = authHeader.value;
    }

    return headers;
}

export async function configureHttpAuthForMicroflow(
    sp: StudioProApi,
    httpConfiguration: Microflows.HttpConfiguration,
    auth: AuthConfig
): Promise<void> {
    // Handle basic auth via httpConfiguration properties
    if (auth.mode === 'basic') {
        httpConfiguration.useAuthentication = true;
        httpConfiguration.httpAuthenticationUserName = '${BASIC_AUTH_USERNAME}';
        httpConfiguration.authenticationPassword = '${BASIC_AUTH_PASSWORD}';
    }

    // Handle token-based auth via headers
    if (auth.mode !== 'none' && auth.mode !== 'basic') {
        const headerName = auth.headerName.trim() || 'Authorization';
        const authHeader = (await sp.app.model.microflows.createElement(
            'Microflows$HttpHeaderEntry'
        )) as Microflows.HttpHeaderEntry;
        authHeader.key = headerName;
        authHeader.value = '${AUTH_TOKEN}';
        httpConfiguration.headerEntries.push(authHeader);
    }
}


