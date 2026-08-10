/**
 * llms.txt (an index) + llms-full.txt (the page markdown) into the docs
 * public/ dir, so the docs stay consumable by AI tooling without scraping HTML.
 * Guides lead the index: a model can re-derive the API surface from the source,
 * but not the prose explaining how it is meant to be used. The changelog is
 * listed under the spec's `## Optional` section and kept out of the full text.
 *
 * `[docs] llms = false` opts out, leaving any existing copies alone. A build
 * with nothing to say REMOVES both files rather than skipping them: a site that
 * lost its guides and sources must not keep serving an index of pages that no
 * longer exist. Published by `build` only.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeIfChanged, type BuildContext } from "./build";
import { docSummary, plainMarkdown } from "./markdown";
import { apiHref, apiPageFile } from "./pages";
import type { EmitResult } from "./render";
import { flattenGuides, readDocPage, readHomePage, type GuideItem } from "./site";

/** llms-full.txt is one flat stream, so every page announces itself. */
function titled(body: string, title: string): string {
	return body.startsWith("# ") ? body : `# ${title}\n\n${body}`;
}

export function syncLlms(context: BuildContext, guides: GuideItem[], result: EmitResult): void {
	const config = context.config;
	if (!config.docs.llms) {
		return;
	}
	const siteUrl = config.docs.url ?? "";
	const entry = (page: { title: string; link: string; description?: string }) =>
		`- [${page.title}](${siteUrl}${page.link})${page.description ? `: ${page.description}` : ""}`;
	const sections: Array<{ heading: string; entries: string[] }> = [];
	const bodies: string[] = [];

	// the hero page contributes a tagline rather than a listing (readHomePage)
	const home = readHomePage(context.docsDir);
	const guidePages = [...(home?.page ? [home.page] : []), ...flattenGuides(guides)];
	if (guidePages.length > 0) {
		sections.push({ heading: "Guides", entries: guidePages.map(entry) });
		for (const guide of guidePages) {
			bodies.push(titled(plainMarkdown(guide.text), guide.title));
		}
	}

	if (result.pageModels.length > 0) {
		const entries: string[] = [];
		for (const page of result.pageModels) {
			entries.push(
				entry({
					title: page.title,
					link: apiHref(page.slug),
					// the same summary the API index page shows
					description: docSummary(page.doc) || undefined,
				}),
			);
			const rendered = result.pages.get(apiPageFile(page.slug));
			if (rendered !== undefined) {
				bodies.push(plainMarkdown(rendered));
			}
		}
		sections.push({ heading: "API Reference", entries });
	}

	// read off disk, not from the sync's decision: a user-authored changelog.md
	// (no generated marker) belongs in the index too
	const changelog = readDocPage(join(context.docsDir, "changelog.md"), "/changelog");
	if (changelog) {
		sections.push({ heading: "Optional", entries: [entry(changelog)] });
	}

	const publicDir = join(context.docsDir, "public");
	// `undefined` means "nothing to say": remove rather than skip
	const write = (name: string, content: string | undefined) => {
		const path = join(publicDir, name);
		if (content !== undefined) {
			writeIfChanged(path, content);
		} else if (existsSync(path)) {
			rmSync(path);
		}
	};

	if (sections.length === 0) {
		write("llms.txt", undefined);
		write("llms-full.txt", undefined);
		return;
	}
	const lines = [`# ${config.title}`, ""];
	const summary = config.description ?? home?.tagline;
	if (summary) {
		lines.push(`> ${summary}`, "");
	}
	for (const section of sections) {
		lines.push(`## ${section.heading}`, "", ...section.entries, "");
	}
	write("llms.txt", lines.join("\n").trimEnd() + "\n");
	// a changelog-only site has an index but no page bodies
	write("llms-full.txt", bodies.length > 0 ? bodies.join("\n\n") + "\n" : undefined);
}
