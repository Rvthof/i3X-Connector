# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A **Mendix Studio Pro Extension** that connects Mendix applications to the [CESMII i3X Smart Manufacturing Platform](https://i3x.cesmii.net/). It fetches object type schemas from the i3X API and generates corresponding Mendix domain model artifacts (entities, attributes, associations, JSON structures, import mappings, microflows) directly inside Studio Pro.

## Commands

```bash
# Type-check and build (one-shot)
npm run build

# Type-check and build with file watching
npm run build:dev
```

There are no test or lint scripts. TypeScript type-checking (`tsc --noEmit`) is the only automated validation step and runs as part of both build scripts.

### Running tsc directly

To type-check without a full build:

```bash
npx tsc --noEmit
```

## Build System

The build uses **esbuild** via `build-extension.mjs` with shared config in `build.helpers.mjs`. It:
1. Compiles two entry points (`src/main/index.ts` → `main.js`, `src/ui/index.tsx` → `list.js`) into `dist/i3X-Connector/`
2. Copies `src/manifest.json` into the output directory
3. Copies the entire output into a hardcoded Mendix app's `extensions/` directory (`appDir` in `build-extension.mjs`)

The `appDir` path in `build-extension.mjs` is developer-specific and must be updated to match the local Mendix project path. The copy step is skipped with a warning if the directory doesn't exist.

Bundles are ESM format with tree-shaking. `@mendix/component-framework` and `@mendix/model-access-sdk` are marked external (provided by the Mendix runtime).

## Architecture

### Two-Bundle Design

Mendix extensions require separate `main` and `ui` bundles, declared in `src/manifest.json`:

- **`src/main/index.ts`** — Registers the "i3X Connector" menu item under Extensions in Studio Pro. Runs in the main process.
- **`src/ui/index.tsx`** — Mounts the React app. Runs in a sandboxed UI context.

The UI cannot directly import from `main` and vice versa; they communicate through the Mendix Extensions API.

### UI Data Flow

```
Loader → List → DetailPanel
```

1. **Loader** (`src/ui/components/loader.tsx`) — User provides the i3X base URL and auth config. Fetches `/objecttypes` via Mendix's HTTP proxy (`sp.network.httpProxy.getProxyUrl()`).
2. **List** (`src/ui/components/list.tsx`) — Displays paginated object types (10/page). Row selection passes the selected `ObjectType` to `DetailPanel`.
3. **DetailPanel** (`src/ui/components/detailpanel.tsx`) — Renders the object's JSON schema hierarchically and triggers `implementObjectAsEntity()` or `createQueryValuesMicroflow()`.

### Services

- **`src/ui/services/auth.ts`** — Builds auth headers for both UI `fetch` calls and Mendix microflow HTTP configurations. Supports `none`, `basic` (Base64 username:password), and `token` (custom header + optional prefix like "Bearer").
- **`src/ui/services/i3xUrl.ts`** — Normalizes user-provided URLs to a canonical base and constructs typed endpoints: `/objecttypes`, `/objects?typeId=<id>`, `/objects/value`.
- **`src/ui/services/studioProService.ts`** — Core code generation logic. `implementObjectAsEntity()` creates entities, attributes, associations, a JSON structure (fetched from `/objects?typeId=`), an import mapping, and a microflow. `createQueryValuesMicroflow()` creates a value-query microflow against `/objects/value`.

`studioProService.ts` is initialized once via `initStudioPro(sp)` in `src/ui/index.tsx` and exposes the singleton via `getStudioPro()`.

### Types

- `src/ui/types/objecttype.ts` — `ObjectType`, `Property`, `LeafProperty`, `GroupProperty`, `ArrayProperty` and type-guard helpers (`isGroupProperty`, `isArrayProperty`, `extractArrayItemProperties`).
- `src/ui/types/connection.ts` — `AuthConfig` (union of none/basic/token) and `ConnectionConfig` (auth + `apiBaseUrl`).

### Naming Conventions for Generated Mendix Artifacts

| Artifact | Pattern | Example |
|---|---|---|
| Entity | `<DisplayName>` | `MotorDrive` |
| Group entity | `<BaseEntity>_<propertyName>` | `MotorDrive_status` |
| Association | `<BaseEntity>_<GroupEntity>` | `MotorDrive_MotorDrive_status` |
| JSON Structure | `JSON_<BaseEntity>` | `JSON_MotorDrive` |
| Import Mapping | `IM_<BaseEntity>` | `IM_MotorDrive` |
| Microflow (type) | `MF_<BaseEntity>` | `MF_MotorDrive` |
| Microflow (value) | `MF_<TypeName>_<ObjectName>` | `MF_MotorDrive_Pump1` |

Names are sanitized via `toModelName()`: non-alphanumeric chars become `_`, consecutive underscores collapse, leading non-letter prefixed with `N_`.

### JSON Schema → Mendix Type Mapping

| JSON Schema type/format | Mendix type |
|---|---|
| `string` (default) | `String` |
| `string` + `date-time` or `date` | `DateTime` |
| `boolean` | `Boolean` |
| `integer` (default) | `Integer` |
| `integer` + `int64` or `long` | `Long` |
| `number` | `Decimal` |
| object/array properties | Associated entity |
