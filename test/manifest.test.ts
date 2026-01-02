import init from "@rainbowatcher/toml-edit-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Github } from "../src/github";
import { logger } from "../src/logger";
import { Manifest } from "../src/manifest";

vi.mock("@rainbowatcher/toml-edit-js", () => ({
    default: vi.fn(),
}));

vi.mock("../src/github", () => {
    return {
        Github: vi.fn(),
    }
});

describe("Manifest", () => {
    describe("#create", () => {
        const token = "token";

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("creates a manifest, initializes TOML and creates a Github client", async () => {
            vi.mocked(init);
            const retrieveDefaultBranch = vi.fn().mockResolvedValue("main");
            vi.mocked(Github).mockImplementation(function GithubMock(this: any) {
                this.retrieveDefaultBranch = retrieveDefaultBranch;
            });

            const result = await Manifest.create("owner/repo", token);
            expect(result).toBeInstanceOf(Manifest);
            expect(init).toHaveBeenCalled();
            expect(Github).toHaveBeenCalledExactlyOnceWith(
                { owner: "owner", repo: "repo" },
                token,
                logger,
            );
            expect(retrieveDefaultBranch).toHaveBeenCalledOnce();
        });

        it("returns null and logs an error for an invalid repository url", async () => {
            vi.spyOn(logger, "error");
            const result = await Manifest.create("invalid", token, logger);

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledExactlyOnceWith("Invalid GitHub repository url 'invalid', expected 'repository/owner' format");
            expect(init).not.toHaveBeenCalled();
        });

        it("propagates errors from retrieveDefaultBranch", async () => {
            vi.mocked(init);
            vi.mocked(Github).mockImplementation(function GithubMock(this: any) {
                this.retrieveDefaultBranch = vi.fn().mockRejectedValue(new Error("boom"));
            });

            await expect(
                Manifest.create("owner/repo", token, logger)
            ).rejects.toThrow("boom");
        });
    });
});
