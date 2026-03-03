import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync, readFileSync } from "fs";
import { join, dirname, basename } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import archiver from "archiver";
import { createWriteStream } from "fs";
import { logger } from "../utils/logger.js";

const execAsync = promisify(exec);

export interface ProjectFile {
  path: string; // Relative path within the project (e.g., "src/index.html")
  content: string; // File content
}

export interface ProjectBuildResult {
  success: boolean;
  projectDir: string;
  zipPath: string;
  files: string[];
  totalSize: number;
  workspaceProjectDir?: string;
  error?: string;
}

export interface ProjectBuildValidationResult {
  success: boolean;
  projectDir: string;
  output: string;
  installRan: boolean;
  buildScriptDetected: boolean;
}

/**
 * ProjectBuilder - Creates project files and packages them into a zip
 */
export class ProjectBuilder {
  private projectDir: string;
  private files: Map<string, string> = new Map();
  private lastInstalledPackageJson: string | null = null;

  constructor(projectName?: string) {
    const name = projectName || `project-${randomUUID().slice(0, 8)}`;
    this.projectDir = join(tmpdir(), "seedstr-builds", name);
    
    // Clean up if exists
    if (existsSync(this.projectDir)) {
      rmSync(this.projectDir, { recursive: true, force: true });
    }
    
    // Create project directory
    mkdirSync(this.projectDir, { recursive: true });
    logger.debug(`Created project directory: ${this.projectDir}`);
  }

  private async runCommand(command: string, args: string[], timeoutMs: number): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync([command, ...args].join(" "), {
        cwd: this.projectDir,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 8,
        env: {
          ...process.env,
          NPM_CONFIG_PRODUCTION: "false",
          NODE_ENV: process.env.NODE_ENV || "development",
        },
      });

      const combined = `${stdout || ""}${stderr || ""}`;
      return { success: true, output: combined };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message?: string };
      const combined = `${execError.stdout || ""}${execError.stderr || ""}${execError.message || ""}`;
      return { success: false, output: combined };
    }
  }

  /**
   * Add a file to the project
   */
  addFile(relativePath: string, content: string): void {
    // Normalize path separators
    const normalizedPath = relativePath.replace(/\\/g, "/");
    this.files.set(normalizedPath, content);
    
    // Write file to disk
    const fullPath = join(this.projectDir, normalizedPath);
    const dir = dirname(fullPath);
    
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    writeFileSync(fullPath, content, "utf-8");
    logger.debug(`Added file: ${normalizedPath} (${content.length} bytes)`);
  }

  /**
   * Add multiple files at once
   */
  addFiles(files: ProjectFile[]): void {
    for (const file of files) {
      this.addFile(file.path, file.content);
    }
  }

  /**
   * Get list of all files in the project
   */
  getFiles(): string[] {
    return Array.from(this.files.keys());
  }

  /**
   * List project files with optional substring path filter
   */
  listFiles(pathContains?: string): string[] {
    const files = this.getFiles().sort((a, b) => a.localeCompare(b));
    if (!pathContains) {
      return files;
    }
    const needle = pathContains.toLowerCase();
    return files.filter((filePath) => filePath.toLowerCase().includes(needle));
  }

  /**
   * Read a file's current content from the in-memory project map
   */
  readFile(relativePath: string): string {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const existing = this.files.get(normalizedPath);
    if (existing === undefined) {
      throw new Error(`File not found: ${normalizedPath}`);
    }
    return existing;
  }

  /**
   * Edit an existing file using search/replace semantics
   */
  editFile(
    relativePath: string,
    search: string,
    replace: string,
    options?: { allOccurrences?: boolean }
  ): {
    path: string;
    replacements: number;
    size: number;
    totalFiles: number;
  } {
    const normalizedPath = relativePath.replace(/\\/g, "/");
    const content = this.readFile(normalizedPath);

    if (search.length === 0) {
      throw new Error("Search string cannot be empty");
    }

    const replaceAll = options?.allOccurrences ?? false;
    let replacements = 0;
    let updated = content;

    if (replaceAll) {
      const parts = content.split(search);
      replacements = parts.length - 1;
      if (replacements === 0) {
        throw new Error(`Search text not found in ${normalizedPath}`);
      }
      updated = parts.join(replace);
    } else {
      const index = content.indexOf(search);
      if (index === -1) {
        throw new Error(`Search text not found in ${normalizedPath}`);
      }
      replacements = 1;
      updated = `${content.slice(0, index)}${replace}${content.slice(index + search.length)}`;
    }

    this.addFile(normalizedPath, updated);

    return {
      path: normalizedPath,
      replacements,
      size: updated.length,
      totalFiles: this.files.size,
    };
  }

  /**
   * Search text in generated project files
   */
  searchText(query: string, options?: { isRegex?: boolean; pathContains?: string; maxResults?: number }): Array<{
    path: string;
    line: number;
    column: number;
    text: string;
  }> {
    const maxResults = Math.max(1, options?.maxResults ?? 200);
    const files = this.listFiles(options?.pathContains);
    const results: Array<{ path: string; line: number; column: number; text: string }> = [];

    if (!query) {
      return results;
    }

    let regex: RegExp | null = null;
    if (options?.isRegex) {
      regex = new RegExp(query, "i");
    }

    for (const path of files) {
      const content = this.readFile(path);
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index++) {
        const lineText = lines[index];
        let matchIndex = -1;

        if (regex) {
          const match = lineText.match(regex);
          if (match && typeof match.index === "number") {
            matchIndex = match.index;
          }
        } else {
          matchIndex = lineText.toLowerCase().indexOf(query.toLowerCase());
        }

        if (matchIndex >= 0) {
          results.push({
            path,
            line: index + 1,
            column: matchIndex + 1,
            text: lineText,
          });
          if (results.length >= maxResults) {
            return results;
          }
        }
      }
    }

    return results;
  }

  /**
   * Get the project directory path
   */
  getProjectDir(): string {
    return this.projectDir;
  }

  /**
   * Ensure a root README.md exists for every deliverable project
   */
  ensureReadme(projectName = "Project"): void {
    const hasReadme = this.getFiles().some((filePath) => filePath.toLowerCase() === "readme.md");
    if (hasReadme) {
      return;
    }

    const fileList = this.getFiles().map((filePath) => `- ${filePath}`).join("\n");
    const readme = `# ${projectName}

## Description
This project was generated by the Seedstr agent as a production-ready deliverable.

## Setup
1. Install dependencies:
   - npm: \`npm install\`
2. Start development server:
   - npm: \`npm run dev\`
3. Build for production:
   - npm: \`npm run build\`

## Files Included
${fileList || "- (project files generated during build)"}

## Notes
- If this is a static HTML/CSS/JS project, open \`index.html\` directly in a browser.
- If this is a framework app (React/Vue/etc), use the project scripts from \`package.json\`.
`;

    this.addFile("README.md", readme);
  }

  /**
   * Validate that a Node project can build successfully.
   * - If no package.json exists, returns success (not a Node build target).
   * - If package.json has no build script, returns success.
   */
  async validateNodeBuild(): Promise<ProjectBuildValidationResult> {
    const packageJsonPath = join(this.projectDir, "package.json");
    if (!existsSync(packageJsonPath)) {
      return {
        success: true,
        projectDir: this.projectDir,
        output: "No package.json found; skipping npm build validation.",
        installRan: false,
        buildScriptDetected: false,
      };
    }

    let buildScriptDetected = false;
    let packageJsonRaw = "";
    try {
      packageJsonRaw = readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(packageJsonRaw) as {
        scripts?: Record<string, string>;
      };
      buildScriptDetected = !!packageJson.scripts?.build;
    } catch {
      return {
        success: false,
        projectDir: this.projectDir,
        output: "Invalid package.json: failed to parse JSON.",
        installRan: false,
        buildScriptDetected: false,
      };
    }

    if (!buildScriptDetected) {
      return {
        success: true,
        projectDir: this.projectDir,
        output: "No build script found in package.json; skipping npm run build validation.",
        installRan: false,
        buildScriptDetected: false,
      };
    }

    const nodeModulesPath = join(this.projectDir, "node_modules");
    let installRan = false;
    const shouldInstall = !existsSync(nodeModulesPath) || this.lastInstalledPackageJson !== packageJsonRaw;
    if (shouldInstall) {
      installRan = true;
      const installResult = await this.runCommand(
        "npm",
        ["install", "--include=dev", "--no-audit", "--no-fund"],
        240000
      );
      if (!installResult.success) {
        return {
          success: false,
          projectDir: this.projectDir,
          output: `npm install failed:\n${installResult.output}\n\nHint: This validator forces devDependencies (Heroku/runtime safe mode). If failures persist, check network/package registry access or package lock compatibility.`.slice(0, 16000),
          installRan,
          buildScriptDetected,
        };
      }
      this.lastInstalledPackageJson = packageJsonRaw;
    }

    let buildResult = await this.runCommand("npm", ["run", "build"], 240000);

    const missingToolBinary = /tsc:\s*not\s*found|vite:\s*not\s*found|next:\s*not\s*found|react-scripts:\s*not\s*found/i.test(buildResult.output);
    if (!buildResult.success && !installRan && missingToolBinary) {
      installRan = true;
      const installRetry = await this.runCommand(
        "npm",
        ["install", "--include=dev", "--no-audit", "--no-fund"],
        240000
      );
      if (installRetry.success) {
        this.lastInstalledPackageJson = packageJsonRaw;
        buildResult = await this.runCommand("npm", ["run", "build"], 240000);
      }
    }

    return {
      success: buildResult.success,
      projectDir: this.projectDir,
      output: buildResult.output.slice(0, 16000),
      installRan,
      buildScriptDetected,
    };
  }

  /**
   * Calculate total size of all files
   */
  private getTotalSize(): number {
    let total = 0;
    for (const content of this.files.values()) {
      total += Buffer.byteLength(content, "utf-8");
    }
    return total;
  }

  /**
   * Save a workspace-visible copy for local inspection.
   */
  private persistWorkspaceCopy(projectSlug: string): string {
    const workspaceRoot = process.cwd();
    const workspaceProjectDir = join(workspaceRoot, "generated-projects", projectSlug);

    if (existsSync(workspaceProjectDir)) {
      rmSync(workspaceProjectDir, { recursive: true, force: true });
    }

    mkdirSync(workspaceProjectDir, { recursive: true });

    for (const [relativePath, content] of this.files.entries()) {
      const fullPath = join(workspaceProjectDir, relativePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, content, "utf-8");
    }

    logger.debug(`Persisted workspace project copy: ${workspaceProjectDir}`);
    return workspaceProjectDir;
  }

  /**
   * Package the project into a zip file
   */
  async createZip(zipName?: string): Promise<ProjectBuildResult> {
    const name = zipName || `${basename(this.projectDir)}.zip`;
    const zipPath = join(dirname(this.projectDir), name);
    const projectSlug = name.replace(/\.zip$/i, "");
    const workspaceProjectDir = this.persistWorkspaceCopy(projectSlug);

    return new Promise((resolve) => {
      try {
        const output = createWriteStream(zipPath);
        const archive = archiver("zip", {
          zlib: { level: 9 }, // Maximum compression
        });

        output.on("close", () => {
          logger.debug(`Created zip: ${zipPath} (${archive.pointer()} bytes)`);
          resolve({
            success: true,
            projectDir: this.projectDir,
            zipPath,
            files: this.getFiles(),
            totalSize: archive.pointer(),
            workspaceProjectDir,
          });
        });

        archive.on("error", (err) => {
          logger.error("Archive error:", err);
          resolve({
            success: false,
            projectDir: this.projectDir,
            zipPath: "",
            files: this.getFiles(),
            totalSize: 0,
            workspaceProjectDir,
            error: err.message,
          });
        });

        archive.pipe(output);

        // Add only generated project files (exclude installed deps/build artifacts)
        for (const [relativePath, content] of this.files.entries()) {
          archive.append(content, { name: relativePath });
        }

        archive.finalize();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Failed to create zip:", message);
        resolve({
          success: false,
          projectDir: this.projectDir,
          zipPath: "",
          files: this.getFiles(),
          totalSize: 0,
          workspaceProjectDir,
          error: message,
        });
      }
    });
  }

  /**
   * Clean up the project directory
   */
  cleanup(): void {
    try {
      if (existsSync(this.projectDir)) {
        rmSync(this.projectDir, { recursive: true, force: true });
        logger.debug(`Cleaned up project directory: ${this.projectDir}`);
      }
    } catch (error) {
      logger.error("Failed to cleanup project directory:", error);
    }
  }
}

/**
 * Build a project from a list of files and return the zip path
 */
export async function buildProject(
  projectName: string,
  files: ProjectFile[]
): Promise<ProjectBuildResult> {
  const builder = new ProjectBuilder(projectName);
  builder.addFiles(files);
  return builder.createZip();
}

/**
 * Get the zip file as a Buffer for uploading
 */
export function getZipBuffer(zipPath: string): Buffer {
  return readFileSync(zipPath);
}

/**
 * Clean up a project's files and zip
 */
export function cleanupProject(projectDir: string, zipPath?: string): void {
  try {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    if (zipPath && existsSync(zipPath)) {
      rmSync(zipPath, { force: true });
    }
  } catch (error) {
    logger.error("Failed to cleanup:", error);
  }
}

export default ProjectBuilder;
