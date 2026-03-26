import type { Microflows } from '@mendix/extensions-api';
import type { AuthConfig } from '../types';

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

export async function applyAuthToHttpConfiguration(
    httpConfiguration: Microflows.HttpConfiguration,
    auth: AuthConfig
): Promise<void> {
    if (auth.mode === 'none') {
        return;
    }

    if (auth.mode === 'basic') {
        httpConfiguration.useAuthentication = true;
        httpConfiguration.httpAuthenticationUserName = auth.username;
        httpConfiguration.authenticationPassword = auth.password;
        return;
    }

    const authHeader = buildAuthHeaderValue(auth)!;
    const header = await httpConfiguration.addHttpHeaderEntry();
    header.key = authHeader.key;
    header.value = authHeader.value;
}
