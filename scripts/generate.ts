/**
 * Generates `src/generated/roblox-names.json` and `extractor/generated/engine.luau`
 * from a single fetch of the pinned Roblox API dump:
 *   - `src/generated/roblox-names.json`: class, enum, and datatype name lists
 *     that the renderer links to Creator Hub docs.
 *   - `extractor/generated/engine.luau`: yielding and plugin-only member names
 *     used by badge detection, plus unambiguous method return types, datatypes,
 *     and enums used by type inference.
 *
 * `bun install` (via `prepare`) and CI run this script automatically so fresh
 * clones have both generated files without checking them into git:
 *
 *   bun run generate           # no-op when both files exist and are current
 *   bun run generate --force   # refetch (e.g., after bumping DUMP_COMMIT)
 *
 * Only this script touches the network: `roblox-names.json` is bundled into
 * `dist/` at build time, so `luaudocs build` never fetches the dump at runtime.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pinned to a specific Roblox-Client-Tracker commit so CI and local checkouts
// read the exact same API dump. To update: set `DUMP_COMMIT` to the latest
// commit on the `roblox` branch and run `bun run generate --force`.
const DUMP_COMMIT = "473b0da05fa3f3ed397be740d08ffb294ba20b39"; // 0.736.0.7361342
const DUMP_URL = `https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/${DUMP_COMMIT}/API-Dump.json`;
const ATTEMPTS = 3;

/** The API dump lists Classes and Enums only; engine datatypes are maintained here. */
const DATATYPES = [
	"Axes",
	"BrickColor",
	"CFrame",
	"CatalogSearchParams",
	"Color3",
	"ColorSequence",
	"ColorSequenceKeypoint",
	"Content",
	"DateTime",
	"DockWidgetPluginGuiInfo",
	"Enum",
	"EnumItem",
	"Enums",
	"Faces",
	"FloatCurveKey",
	"Font",
	"NumberRange",
	"NumberSequence",
	"NumberSequenceKeypoint",
	"OverlapParams",
	"Path2DControlPoint",
	"PathWaypoint",
	"PhysicalProperties",
	"Random",
	"Ray",
	"RaycastParams",
	"RaycastResult",
	"RBXScriptConnection",
	"RBXScriptSignal",
	"Rect",
	"Region3",
	"Region3int16",
	"RotationCurveKey",
	"Secret",
	"SharedTable",
	"TweenInfo",
	"UDim",
	"UDim2",
	"Vector2",
	"Vector2int16",
	"Vector3",
	"Vector3int16",
];

interface DumpType {
	Category: string;
	Name: string;
}

interface DumpMember {
	MemberType: string;
	Name: string;
	Tags?: string[];
	Security?: unknown;
	ReturnType?: DumpType;
}

interface Dump {
	Classes: Array<{ Name: string; Members?: DumpMember[] }>;
	Enums: Array<{ Name: string }>;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repoRoot, "src", "generated", "roblox-names.json");
const engineOut = join(repoRoot, "extractor", "generated", "engine.luau");

/** Table keys emitted in `engine.luau`, matching `EngineLists` in `extractor/engine.luau`.
 * Shared between the writer and `engineIsCurrent` so an older generated file
 * missing a newly added table triggers a regeneration. */
const ENGINE_LISTS = [
	"yieldingMethods",
	"pluginMembers",
	"methodReturns",
	"datatypes",
	"enums",
] as const;

/** Formats the opening line of a table in `engine.luau` (shared by the writer and `engineIsCurrent`). */
function listHeader(name: string): string {
	return `\t${name} = {`;
}

/** Excludes short generic verb+noun names (`GetCore`, `IsDisabled`) that user
 * code commonly defines for non-yielding methods. */
const GENERIC_NAME = /^(?:Get|Set|Is|Has|Can)[A-Z][a-z0-9]*$/;

/** Restricts plugin-only detection to unmistakably Studio/Plugin-specific method
 * names so generic names like `Add`, `Undo`, or `SetEnabled` do not trigger false badges. */
const PLUGIN_TOKEN = /Plugin|Toolbar|Ribbon|Breakpoint|DockWidget|Studio/;

/** Maps an API-dump return type to its Luau type spelling, or `null` for `void`
 * and vague container types (`Tuple`, `Variant`, `Dictionary`). `Instances` and
 * `Objects` map to `{ Instance }`. */
function luauType(type: DumpType | undefined): string | null {
	if (type === undefined) {
		return null;
	}
	switch (type.Category) {
		case "Primitive":
			return (
				{
					bool: "boolean",
					float: "number",
					int: "number",
					int64: "number",
					double: "number",
					string: "string",
				}[type.Name] ?? null
			);
		case "Enum":
			return `Enum.${type.Name}`;
		case "Class":
			return type.Name;
		case "DataType":
			return type.Name === "Instances" || type.Name === "Objects"
				? "{ Instance }"
				: type.Name;
		default:
			return null;
	}
}

/**
 * Extracts unambiguous yielding and plugin-only method names for badge detection
 * (excluding any name that also appears on a non-yielding or open-security method).
 */
function engineLists(dump: Dump): { yieldingMethods: string[]; pluginMembers: string[] } {
	const yielding = new Set<string>();
	const nonYielding = new Set<string>();
	const plugin = new Set<string>();
	const open = new Set<string>();
	for (const cls of dump.Classes) {
		for (const member of cls.Members ?? []) {
			if (member.MemberType !== "Function") {
				continue;
			}
			(member.Tags?.includes("Yields") ? yielding : nonYielding).add(member.Name);
			if (member.Security === "PluginSecurity") {
				plugin.add(member.Name);
			} else if (member.Security === "None") {
				open.add(member.Name);
			}
		}
	}
	const yieldingMethods = [...yielding]
		.filter((name) => !nonYielding.has(name) && !GENERIC_NAME.test(name))
		.sort();
	const pluginMembers = [...plugin]
		.filter((name) => !open.has(name) && PLUGIN_TOKEN.test(name))
		.sort();
	return { yieldingMethods, pluginMembers };
}

/**
 * Builds a `methodName -> returnType` map for inferring method call results on
 * values already known to be Roblox `Instance`s. Includes only method names
 * that have the exact same non-null return type across every class in the dump.
 */
function methodReturns(dump: Dump): Array<[string, string]> {
	const byName = new Map<string, Set<string | null>>();
	for (const cls of dump.Classes) {
		for (const member of cls.Members ?? []) {
			if (member.MemberType !== "Function") {
				continue;
			}
			const returns = byName.get(member.Name) ?? new Set<string | null>();
			returns.add(luauType(member.ReturnType));
			byName.set(member.Name, returns);
		}
	}
	return [...byName]
		.flatMap(([name, returns]): Array<[string, string]> => {
			const [only] = [...returns];
			return returns.size === 1 && only != null ? [[name, only]] : [];
		})
		.sort(([a], [b]) => (a < b ? -1 : 1));
}

function luauSet(names: string[]): string {
	return names.map((name) => `\t\t${name} = true,`).join("\n");
}

function luauMap(entries: Array<[string, string]>): string {
	return entries.map(([name, value]) => `\t\t${name} = "${value}",`).join("\n");
}

/**
 * Fetches the API dump with exponential backoff so a transient CDN failure does
 * not break `bun install` or CI.
 */
async function fetchDump(): Promise<Dump> {
	let last: unknown;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		try {
			const response = await fetch(DUMP_URL);
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}`);
			}
			return (await response.json()) as Dump;
		} catch (error) {
			last = error;
			if (attempt < ATTEMPTS) {
				const backoff = 500 * 2 ** (attempt - 1);
				console.warn(
					`fetching the API dump failed (attempt ${attempt}/${ATTEMPTS}), retrying in ${backoff}ms`,
				);
				await new Promise((resolve) => setTimeout(resolve, backoff));
			}
		}
	}
	throw new Error(`fetching the API dump failed after ${ATTEMPTS} attempts: ${last}`);
}

/**
 * Checks whether an existing `engine.luau` on disk includes every table in
 * `ENGINE_LISTS`.
 */
function engineIsCurrent(): boolean {
	if (!existsSync(engineOut)) {
		return false;
	}
	const source = readFileSync(engineOut, "utf8");
	return ENGINE_LISTS.every((name) => source.includes(listHeader(name)));
}

async function generateRobloxNames(force: boolean): Promise<void> {
	if (existsSync(out) && engineIsCurrent() && !force) {
		console.log("roblox-names.json and engine.luau are present; pass --force to refetch");
		return;
	}

	const dump = await fetchDump();
	if (!Array.isArray(dump.Classes) || !Array.isArray(dump.Enums)) {
		throw new Error(
			"the API dump is missing Classes/Enums: refusing to write a truncated name list",
		);
	}

	const names = {
		datatypes: [...DATATYPES].sort(),
		classes: dump.Classes.map((cls) => cls.Name).sort(),
		enums: dump.Enums.map((enumEntry) => enumEntry.Name).sort(),
	};

	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(names, null, "\t") + "\n");
	console.log(
		`wrote ${out}: ${names.classes.length} classes, ${names.enums.length} enums, ${names.datatypes.length} datatypes`,
	);

	const engine = engineLists(dump);
	const returns = methodReturns(dump);
	const bodies: Record<(typeof ENGINE_LISTS)[number], string> = {
		yieldingMethods: luauSet(engine.yieldingMethods),
		pluginMembers: luauSet(engine.pluginMembers),
		methodReturns: luauMap(returns),
		datatypes: luauSet(names.datatypes),
		enums: luauSet(names.enums),
	};
	const engineSource = [
		"-- Generated by `bun run generate` from the Roblox API dump; never checked",
		"-- in (the prepare hook and CI refresh it). Detection falls back to its",
		"-- built-in convention signals alone when this file is absent, and type",
		"-- inference to the engine-blind half of what it knows.",
		"return {",
		...ENGINE_LISTS.flatMap((name) => [listHeader(name), bodies[name], "\t},"]),
		"}",
		"",
	].join("\n");
	mkdirSync(dirname(engineOut), { recursive: true });
	writeFileSync(engineOut, engineSource);
	console.log(
		`wrote ${engineOut}: ${engine.yieldingMethods.length} yielding methods, ${engine.pluginMembers.length} plugin members, ${returns.length} method returns`,
	);
}

await generateRobloxNames(process.argv.includes("--force"));
