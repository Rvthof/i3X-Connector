import React, { useState } from 'react';
import { getStudioProApi } from '@mendix/extensions-api';
import styles from '../index.module.css';
import { LoaderProps } from '../types';

const Loader: React.FC<LoaderProps> = ({ context, setApiData, setApiUrl }) => {
    const studioPro = getStudioProApi(context);
    const messageApi = studioPro.ui.messageBoxes;
    const [url, setUrl] = useState('https://i3x.cesmii.net/objecttypes');
    const [loading, setLoading] = useState(false);

    const isValidUrl = (urlString: string): boolean => {
        try { return !!new URL(urlString); } catch { return false; }
    };

    const handleLoad = async () => {
        if (!isValidUrl(url)) {
            await messageApi.show('error', `Invalid URL: "${url}". Please enter a valid URL.`);
            return;
        }
        setLoading(true);
        try {
            const proxy = await studioPro.network.httpProxy.getProxyUrl(url);
            const response = await fetch(proxy, { headers: { 'accept': 'application/json' } });
            if (!response.ok) {
                await messageApi.show('error', `Request failed with status ${response.status}.`);
                return;
            }
            const data = await response.json();
            setApiUrl(url);
            setApiData(data);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await messageApi.show('error', `Error fetching data: ${msg}`);
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') handleLoad();
    };

    return (
        <div className={styles.loaderContainer}>
            <input
                className={styles.loaderInput}
                type="text"
                value={url}
                placeholder="Enter URL, e.g. https://i3x.cesmii.net/objecttypes"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={loading}
            />
            <button className={styles.loaderButton} onClick={handleLoad} disabled={loading}>
                {loading ? 'Loading…' : 'Load'}
            </button>
        </div>
    );
};

export default Loader;
