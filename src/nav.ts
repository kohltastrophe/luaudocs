/**
 * Navigation = the public access graph.
 *
 * A reader reaches `Flux.Motion.Color` by indexing the root module's result, so
 * that is the shape the nav takes: every edge is a module the parent's value
 * re-exports. Modules the root never exposes fall back to the instance
 * hierarchy and attach to the nearest module above them. One tree, three
 * readings: the sidebar heads a section with each entry module and hangs its
 * subtree under it, the API index page keeps the tree whole (there the nesting
 * *is* the access path), and `apiTrails` hands each page the chain above it.
 */
import { docSummary, region } from "./markdown";
import {
	apiHref,
	apiPageFile,
	compareTitles,
	displayTitle,
	generatedFrontmatter,
	type PageModel,
} from "./pages";
import type { TrailSegment } from "../templates/runtime/markup";

/** The API index: the sidebar's first entry, and where every page trail starts. */
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
}

/**
 * Parent of every page: the module that re-exports it, else the module it sits
 * inside. Pages with no parent become roots.
 */
function parentOf(pages: PageModel[]): Map<string, string | undefined> {
	const byId = new Map(pages.map((page) => [page.moduleId, page]));
	const parent = new Map<string, string | undefined>();

	// breadth-first from the entry modules, so each page lands on its shortest
	// public access path
	const queue = pages.filter((page) => page.entry);
	for (const page of queue) {
		parent.set(page.moduleId, undefined);
	}
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const page = queue[cursor]!;
		for (const childId of page.exports) {
			const child = byId.get(childId);
			if (child && !parent.has(childId)) {
				parent.set(childId, page.moduleId);
				queue.push(child);
			}
		}
	}

	// everything else: nearest enclosing module in the instance tree
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
		// depth 0 is the project root: an entry module sitting there owns the
		// modules beside it, so the walk must not stop one level short
		for (let depth = own.length - 1; depth >= 0 && found === undefined; depth -= 1) {
			const ancestor = byLocation.get(own.slice(0, depth).join("\u0000"));
			if (ancestor && ancestor.moduleId !== page.moduleId) {
				found = ancestor.moduleId;
			}
		}
		parent.set(page.moduleId, found);
	}
	return parent;
}

const byTitle = (a: PageModel, b: PageModel) => compareTitles(a.title, b.title);
const byNodeTitle = (a: TreeNode, b: TreeNode) => byTitle(a.page, b.page);

/** Roots first (entry modules in project order), each child list sorted by title. */
export function buildAccessTree(pages: PageModel[]): TreeNode[] {
	const parent = parentOf(pages);
	const nodes = new Map<string, TreeNode>(
		pages.map((page) => [page.moduleId, { page, children: [] }]),
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
 * What sits above each page inside the API: the index, then every module the
 * page is reached through, itself excluded. Keyed by the file the page renders
 * from; the index page is in here too, with nothing above it.
 */
export function apiTrails(tree: TreeNode[]): Map<string, TrailSegment[]> {
	const trails = new Map<string, TrailSegment[]>();
	if (tree.length === 0) {
		// no pages, so no index page either: nothing here has a trail
		return trails;
	}
	trails.set(apiPageFile("index"), []);
	const walk = (node: TreeNode, above: TrailSegment[]) => {
		trails.set(apiPageFile(node.page.slug), above);
		// the bare title, not `displayTitle`: a collision's parenthetical says
		// what the trail above it is already showing
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

function pageItem(page: PageModel): SidebarItem {
	return { text: displayTitle(page), link: apiHref(page.slug) };
}

function nodeItem(node: TreeNode): SidebarItem {
	if (node.children.length === 0) {
		return pageItem(node.page);
	}
	return {
		text: displayTitle(node.page),
		link: apiHref(node.page.slug),
		collapsed: true,
		items: node.children.map(nodeItem),
	};
}

export function apiSidebar(pages: PageModel[], tree = buildAccessTree(pages)): SidebarItem[] {
	// no pages means no API section at all: the index link would 404
	if (pages.length === 0) {
		return [];
	}
	// the index heads nothing: the empty `items` is what keeps it a section
	// title anyway, since VitePress folds a top-level entry without an `items`
	// key into an untitled group one level down (getSidebarGroups, in the theme)
	const sections: SidebarItem[] = [{ ...API_INDEX, items: [] }];
	// an entry module heads its own section rather than standing beside the
	// modules it exposes, which read as its peers
	const loose: TreeNode[] = [];
	for (const root of tree) {
		if (root.page.entry && root.children.length > 0) {
			sections.push({
				text: displayTitle(root.page),
				link: apiHref(root.page.slug),
				items: root.children.map(nodeItem),
			});
		} else {
			// an entry exposing nothing heads nothing: it is one more page
			loose.push(root);
		}
	}
	// whatever no entry reaches, in the tree's order (entries first, then title)
	if (loose.length > 0) {
		sections.push({ text: "Reference", items: loose.map(nodeItem) });
	}
	return sections;
}

/**
 * The access tree as a nested list inside a `luaudocs-tree` wrapper, which is
 * what trades the bullets for drawn tree lines (see luaudocs.css). The markup
 * stays a list so the nesting survives anywhere the markdown is read as
 * markdown. `linkify` is the emitter's prose-reference resolver.
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
	// the same region markers renderPage writes around each block, so a guide can
	// embed the access tree
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
