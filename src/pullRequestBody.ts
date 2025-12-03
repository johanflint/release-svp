const HEADER = ":bowtie: I have created a release";
const FOOTER = "This pull request was generated with [Release SVP](https://github.com/johanflint/release-svp).";
const NOTES_DELIMITER = "---";

export function createPullRequestBody(body: string) {
    return `${HEADER}
${NOTES_DELIMITER}


${body}

${NOTES_DELIMITER}
${FOOTER}`;
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
