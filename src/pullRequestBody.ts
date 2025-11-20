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
