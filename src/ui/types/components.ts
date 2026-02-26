import { ComponentContext } from '@mendix/extensions-api';
import { ObjectType } from './objecttype';

export interface LoaderProps {
    context: ComponentContext;
    setApiData: (data: unknown) => void;
    setApiUrl: (url: string) => void;
}

export interface ListProps {
    apiData: unknown;
    selectedId: string | null;
    onSelect: (item: ObjectType) => void;
}
