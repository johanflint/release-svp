const HEADER = ":bowtie: I have created a release";
const FOOTER = "This pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).";
const NOTES_DELIMITER = "---";

// Captures group 1 (component name, possibly empty) and group 2 (that component's notes) from between a
// matching start/end marker pair. `[^ >]*` for the component name is safe: component names are validated
// elsewhere (see manifestConfig.ts, COMPONENT_NAME_PATTERN) to only ever contain letters, digits, '.', '_' or
// '-', so they can never contain a space or '>' that would let this under- or over-match a marker's boundary.
const COMPONENT_SECTION_PATTERN = /<!-- release-svp:component:([^ >]*) -->\n([\s\S]*?)\n<!-- \/release-svp:component:\1 -->/g;

export interface ComponentSection {
    readonly componentName: string;
    readonly notes: string;
}

// One pull request body can bundle several components' release notes together (see README.md, "Combined
// release pull requests"). Each entry becomes its own marked, independently addressable section — see
// `extractComponentSections` for the read side.
export function createPullRequestBody(sections: readonly ComponentSection[]): string {
    const content = sections
        .map(section => `${componentSectionStart(section.componentName)}\n${section.notes}\n${componentSectionEnd(section.componentName)}`)
        .join("\n\n");

    return `${HEADER}
${NOTES_DELIMITER}


${content}

${NOTES_DELIMITER}
${FOOTER}`;
}

// Marks the start/end of one component's release notes within a pull request body, so a single pull request
// covering several components (see README.md, "Combined release pull requests") can be parsed per-component
// instead of the whole content being treated as one block. HTML comments so they render invisibly on GitHub.
// `componentName` is "" for the root component (single-project, backward-compatible naming — see
// componentNaming.ts).
function componentSectionStart(componentName: string): string {
    return `<!-- release-svp:component:${componentName} -->`;
}

function componentSectionEnd(componentName: string): string {
    return `<!-- /release-svp:component:${componentName} -->`;
}

// Extracts every component's marked release-notes section from a pull request body's content (see
// `parsePullRequestBody`). Returns an empty array when there are no markers at all — e.g. a pull request opened
// by an older, pre-combined-PR version of the tool, whose entire content belongs to whichever single component
// the pull request already identifies via its branch/label (see release.ts, `extractNotesForComponent`, for how
// callers handle that fallback).
export function extractComponentSections(content: string): ComponentSection[] {
    return Array.from(content.matchAll(COMPONENT_SECTION_PATTERN))
        .map(match => ({ componentName: match[1], notes: match[2] }));
}

export interface PullRequestBody {
    header: string;
    content: string;
    footer: string;
}

export function parsePullRequestBody(body: string): PullRequestBody | undefined {
    const lines = body.trim().replace(/\r\n/g, "\n").split("\n");
    const index = lines.indexOf(NOTES_DELIMITER);
    if (index === -1) {
        return undefined;
    }

    let lastIndex = lines.lastIndexOf(NOTES_DELIMITER);
    if (lastIndex === index) {
        lastIndex = lines.length - 1;
    }

    const header = lines.slice(0, index).join('\n').trim();
    const content = lines.slice(index + 1, lastIndex).join('\n');
    const footer = lines.slice(lastIndex + 1).join('\n');
    return { header, content, footer }
}
