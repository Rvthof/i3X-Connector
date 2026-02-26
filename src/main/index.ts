import { IComponent, getStudioProApi } from "@mendix/extensions-api";

export const component: IComponent = {
    async loaded(componentContext) {
        const studioPro = getStudioProApi(componentContext);

        await studioPro.ui.extensionsMenu.add({
            menuId: "i3X-Connector.MainMenu",
            caption: "i3X Connector",
            action: async () => {
                await studioPro.ui.tabs.open(
                    {
                        title: "i3X Connector"
                    },
                    {
                        componentName: "extension/i3X-Connector",
                        uiEntrypoint: "list"
                    }
                );
            }
        });
    }
}
