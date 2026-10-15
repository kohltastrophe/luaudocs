/**
 * Builds API navigation from the public access graph.
 *
 * Because callers reach a submodule like `Flux.Motion.Color` by indexing the
 * root module's return value, navigation follows re-export edges from each
 * entry module. Modules not reached by any entry module fall back to the
 * instance hierarchy and attach to their nearest enclosing ancestor module.
 *
 * One access tree drives four views:
 * - `apiSidebar`: heads a sidebar section with each entry module and nests its
 *   subtree beneath it
 * - `renderApiIndex`: renders the tree as a nested list on `/api/`
 * - `apiTrails`: records the breadcrumb trail above each API page
 * - `apiSections` (in `src/llms.ts`): heads each module in the checkout
 *   `llms.txt` with its public access path
 */
import { docSummary, region } from "./markdown";
import {
	apiHref,
	apiPageFile,
	compareTitles,
	displayTitle,
	generatedFrontmatter,
	memberAccess,
	type PageModel,
} from "./pages";
import type { TrailSegment } from "../templates/runtime/markup";

/** The API overview entry: first item in the API sidebar and root of every API page trail. */
const API_INDEX: TrailSegment = { text: "Overview", link: apiHref("") };

export interface SidebarItem {
	text: string;
	link?: string;
	collapsed?: boolean;
	items?: SidebarItem[];
}

export interface TreeNode {
	page: PageModel;
	children: TreeNode[];
	/**
	 * Public access path from an entry module (`Flux.Util.Queue`), with the
	 * entry module itself spelled by its title. Absent when no entry module
	 * reaches this page and it attaches to an instance-tree ancestor instead.
	 */
	access?: string;
}

/**
 * Computes the parent module ID and public access path (`access`) for every page:
 * prefers the first module that re-exports it (breadth-first from entry modules),
 * falling back to the nearest enclosing module in the instance hierarchy. Pages
 * with `parent.get(id) === undefined` become tree roots.
 */
function parentOf(pages: PageModel[]): {
	parent: Map<string, string | undefined>;
	access: Map<string, string>;
} {
	const byId = new Map(pages.map((page) => [page.moduleId, page]));
	const parent = new Map<string, string | undefined>();
	const access = new Map<string, string>();

	// Walk breadth-first from entry modules so every reachable module gets its
	// shortest public access path.
	const queue = pages.filter((page) => page.entry);
	for (const page of queue) {
		parent.set(page.moduleId, undefined);
		access.set(page.moduleId, page.title);
	}
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const page = queue[cursor]!;
		for (const edge of page.exports) {
			const child = byId.get(edge.moduleId);
			if (child && !parent.has(edge.moduleId)) {
				parent.set(edge.moduleId, page.moduleId);
				access.set(edge.moduleId, memberAccess(access.get(page.moduleId)!, edge.name));
				queue.push(child);
			}
		}
	}

	// Attach remaining modules to their nearest enclosing module in the instance tree.
	const byLocation = new Map<string, PageModel>();
	for (const page of pages) {
		const key = page.instancePath.join("\u0000");
		if (!byLocation.has(key)) {
			byLocation.set(key, page);
		}
	}
	for (const page of pages) {
		if (parent.has(page.moduleId)) {
			continue;
		}
		const own = page.instancePath;
		let found: string | undefined;
		// Walk down to depth 0 (the project root) so an entry module at the root
		// still parents sibling modules alongside it.
		for (let depth = own.length - 1; depth >= 0 && found === undefined; depth -= 1) {
			const ancestor = byLocation.get(own.slice(0, depth).join("\u0000"));
			if (ancestor && ancestor.moduleId !== page.moduleId) {
				found = ancestor.moduleId;
			}
		}
		parent.set(page.moduleId, found);
	}
	return { parent, access };
}

const byTitle = (a: PageModel, b: PageModel) => compareTitles(a.title, b.title);
const byNodeTitle = (a: TreeNode, b: TreeNode) => byTitle(a.page, b.page);

/** Builds the access tree: entry roots in project order first, remaining roots and children sorted by title. */
export function buildAccessTree(pages: PageModel[]): TreeNode[] {
	const { parent, access } = parentOf(pages);
	const nodes = new Map<string, TreeNode>(
		pages.map((page) => [
			page.moduleId,
			{ page, children: [], access: access.get(page.moduleId) },
		]),
	);
	const roots: TreeNode[] = [];
	for (const page of pages) {
		const node = nodes.get(page.moduleId)!;
		const parentNode = nodes.get(parent.get(page.moduleId) ?? "");
		if (parentNode) {
			parentNode.children.push(node);
		} else {
			roots.push(node);
		}
	}
	for (const node of nodes.values()) {
		node.children.sort(byNodeTitle);
	}
	const entries = roots.filter((node) => node.page.entry);
	const rest = roots.filter((node) => !node.page.entry).sort(byNodeTitle);
	return [...entries, ...rest];
}

/**
 * Computes the breadcrumb trail above each API page (starting with `Overview`,
 * followed by each ancestor module), keyed by emitted filename (`Slug.md`).
 * Includes `index.md` with an empty trail (`[]`).
 */
export function apiTrails(tree: TreeNode[]): Map<string, TrailSegment[]> {
	const trails = new Map<string, TrailSegment[]>();
	if (tree.length === 0) {
		// No API pages emitted, so no `api/index.md` page exists either.
		return trails;
	}
	trails.set(apiPageFile("index"), []);
	const walk = (node: TreeNode, above: TrailSegment[]) => {
		trails.set(apiPageFile(node.page.slug), above);
		// Use the bare `page.title` rather than `displayTitle`: the trail above
		// already shows the parent module that `navTitle`'s parenthetical names.
		const below = [...above, { text: node.page.title, link: apiHref(node.page.slug) }];
		for (const child of node.children) {
			walk(child, below);
		}
	};
	for (const root of tree) {
		walk(root, [API_INDEX]);
	}
	return trails;
}

function nodeItem(node: TreeNode): SidebarItem {
	return {
		text: displayTitle(node.page),
		link: apiHref(node.page.slug),
		...(node.children.length > 0
			? { collapsed: true, items: node.children.map(nodeItem) }
			: {}),
	};
}

export function apiSidebar(tree: TreeNode[]): SidebarItem[] {
	// Return an empty sidebar when no API pages exist so `/api/` is not linked.
	if (tree.length === 0) {
		return [];
	}
	// Give `Overview` an empty `items: []` array so VitePress renders it as a
	// top-level section title instead of folding it into an untitled group one
	// level down (`getSidebarGroups` in VitePress's default theme).
	const sections: SidebarItem[] = [{ ...API_INDEX, items: [] }];
	// Each entry module with children heads its own sidebar section; entry
	// modules without children and unreached roots collect under `Reference`.
	const loose: TreeNode[] = [];
	for (const root of tree) {
		if (root.page.entry && root.children.length > 0) {
			sections.push({
				text: displayTitle(root.page),
				link: apiHref(root.page.slug),
				items: root.children.map(nodeItem),
			});
		} else {
			loose.push(root);
		}
	}
	if (loose.length > 0) {
		sections.push({ text: "Reference", items: loose.map(nodeItem) });
	}
	return sections;
}

/**
 * Renders `/api/index.md`: the access tree as a nested Markdown list inside a
 * `.luaudocs-tree` wrapper (styled with tree branch lines in `luaudocs.css`
 * while remaining standard Markdown for `llms-full.txt`).
 */
export function renderApiIndex(tree: TreeNode[], linkify: (markdown: string) => string): string {
	const lines: string[] = [];
	const walk = (node: TreeNode, depth: number) => {
		const first = docSummary(node.page.doc);
		const summary = first ? `: ${linkify(first)}` : "";
		lines.push(
			`${"    ".repeat(depth)}- [${displayTitle(node.page)}](${apiHref(node.page.slug)})${summary}`,
		);
		for (const child of node.children) {
			walk(child, depth + 1);
		}
	};
	for (const root of tree) {
		walk(root, 0);
	}
	// Wrap in `#region reference` markers so guides can embed the access tree.
	return (
		[
			generatedFrontmatter("API Reference"),
			"<!-- generated by luaudocs -->",
			"# API Reference",
			region("reference"),
			'<div class="luaudocs-tree">',
			lines.join("\n"),
			"</div>",
			region("reference", true),
		].join("\n\n") + "\n"
	);
}
