import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build, context, type BuildOptions } from "esbuild";

export interface PublicProductConfig {
  notionClientId: string;
  oauthBrokerUrl: string;
}

export interface ExtensionBuildOptions {
  outdir?: string;
  debug?: boolean;
  watch?: boolean;
  fixture?: boolean;
  productConfig?: PublicProductConfig;
}

const projectRoot = path.resolve(import.meta.dirname, "..");

export async function buildExtension({
  outdir = path.join(projectRoot, "dist"),
  debug = false,
  watch = false,
  fixture = false,
  productConfig = { notionClientId: "", oauthBrokerUrl: "" }
}: ExtensionBuildOptions = {}): Promise<void> {
  await mkdir(outdir, { recursive: true });

  if (fixture) {
    await runBuild({
      entryPoints: [path.join(projectRoot, "tests/fixtures/mv3-worker-entry.ts")],
      outfile: path.join(outdir, "mv3-worker-harness.js"),
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome116",
      sourcemap: debug,
      logLevel: "info"
    }, watch);
    return;
  }

  const shared: BuildOptions = {
    bundle: true,
    platform: "browser",
    target: "chrome116",
    sourcemap: debug,
    logLevel: "info"
  };
  await Promise.all([
    runBuild({
      ...shared,
      entryPoints: [path.join(projectRoot, "src/content.ts")],
      outfile: path.join(outdir, "content.js"),
      format: "iife",
      charset: "utf8",
      drop: debug ? [] : ["console"],
      minify: !debug
    }, watch),
    runBuild({
      ...shared,
      entryPoints: {
        background: path.join(projectRoot, "src/background.ts"),
        options: path.join(projectRoot, "options/options.ts")
      },
      outdir,
      format: "esm",
      plugins: [{
        name: "external-product-config",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /(?:^|\/)product-config\.js$/ }, () => ({
            path: "./product-config.js",
            external: true
          }));
        }
      }]
    }, watch)
  ]);
  await writeProductConfig(outdir, productConfig);
}

async function runBuild(options: BuildOptions, watch: boolean): Promise<void> {
  if (watch) {
    const buildContext = await context(options);
    await buildContext.watch();
    return;
  }
  await build(options);
}

async function writeProductConfig(outdir: string, config: PublicProductConfig): Promise<void> {
  const source = `// Generated public product configuration.\nexport const PRODUCT_CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});\n`;
  await writeFile(path.join(outdir, "product-config.js"), source);
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outdir = readArgument("--outdir");
  await buildExtension({
    ...(outdir ? { outdir } : {}),
    debug: process.argv.includes("--debug"),
    watch: process.argv.includes("--watch"),
    fixture: process.argv.includes("--fixture")
  });
}
