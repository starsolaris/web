import fs from 'fs';
import path from 'path';
import rimraf from 'rimraf';
import mkdirp from 'mkdirp';
import chalk from 'chalk';
import glob from 'glob';
import ora from 'ora';
import yargs from 'yargs-parser';
import resolveFrom from 'resolve-from';
import babelPresetEnv from '@babel/preset-env';
import isNodeBuiltin from 'is-builtin-module';

import * as rollup from 'rollup';
import rollupPluginNodeResolve from 'rollup-plugin-node-resolve';
import rollupPluginCommonjs from 'rollup-plugin-commonjs';
import {terser as rollupPluginTerser} from 'rollup-plugin-terser';
import rollupPluginReplace from 'rollup-plugin-replace';
import rollupPluginJson from 'rollup-plugin-json';
import rollupPluginBabel from 'rollup-plugin-babel';
import {rollupPluginTreeshakeInputs} from './rollup-plugin-treeshake-inputs.js';
import {rollupPluginRemoteResolve} from './rollup-plugin-remote-resolve.js';
import {scanImports, scanDepList, InstallTarget} from './scan-imports.js';

export interface DependencyLoc {
  type: 'JS' | 'ASSET';
  loc: string;
}

export interface InstallOptions {
  destLoc: string;
  include?: string;
  isCleanInstall?: boolean;
  isStrict?: boolean;
  isOptimized?: boolean;
  isBabel?: boolean;
  hasBrowserlistConfig?: boolean;
  isExplicit?: boolean;
  namedExports?: {[filepath: string]: string[]};
  remoteUrl?: string;
  remotePackages: [string, string][];
  sourceMap?: boolean | 'inline';
  dedupe?: string[];
}

const cwd = process.cwd();
const banner = chalk.bold(`@pika/web`) + ` installing... `;
const installResults = [];
let spinner = ora(banner);
let spinnerHasError = false;

function printHelp() {
  console.log(
    `
${chalk.bold(`@pika/web`)} - Install npm dependencies to run natively on the web.
${chalk.bold('Options:')}
    --dest              Specify destination directory (default: "web_modules/").
    --clean             Clear out the destination directory before install.
    --optimize          Transpile, minify, and optimize installed dependencies for production.
    --babel             Transpile installed dependencies. Also enabled with "--optimize".
    --include           Auto-detect imports from file(s). Supports glob.
    --strict            Only install pure ESM dependency trees. Fail if a CJS module is encountered.
    --no-source-map     Skip emitting source map files (.js.map) into dest
${chalk.bold('Advanced:')}
    --remote-package    "name,version" pair(s) of packages that should be left unbundled and referenced remotely.
                        Example: "foo,v4" will rewrite all imports of "foo" to "{remoteUrl}/foo/v4" (see --remote-url).
    --remote-url        Configures the domain where remote imports point to (default: "https://cdn.pika.dev")
    `.trim(),
  );
}

function formatInstallResults(skipFailures): string {
  return installResults
    .map(([d, yn]) => (yn ? chalk.green(d) : skipFailures ? chalk.dim(d) : chalk.red(d)))
    .join(', ');
}

function logError(msg) {
  if (!spinnerHasError) {
    spinner.stopAndPersist({symbol: chalk.cyan('⠼')});
  }
  spinnerHasError = true;
  spinner = ora(chalk.red(msg));
  spinner.fail();
}

class ErrorWithHint extends Error {
  constructor(message: string, public readonly hint: string) {
    super(message);
  }
}

// Add common, well-used non-esm packages here so that Rollup doesn't die trying to analyze them.
const PACKAGES_TO_AUTO_DETECT_EXPORTS = [
  path.join('react', 'index.js'),
  path.join('react-dom', 'index.js'),
  path.join('react-is', 'index.js'),
  path.join('prop-types', 'index.js'),
  path.join('rxjs', 'Rx.js'),
];

function detectExports(filePath: string): string[] | undefined {
  try {
    const fileLoc = resolveFrom(cwd, filePath);
    if (fs.existsSync(fileLoc)) {
      return Object.keys(require(fileLoc)).filter(e => e[0] !== '_');
    }
  } catch (err) {
    // ignore
  }
}

/**
 * Resolve a "webDependencies" input value to the correct absolute file location.
 * Supports both npm package names, and file paths relative to the node_modules directory.
 * Follows logic similar to Node's resolution logic, but using a package.json's ESM "module"
 * field instead of the CJS "main" field.
 */
function resolveWebDependency(dep: string, isExplicit: boolean): DependencyLoc {
  // if the path includes a file extension, just use it
  if (path.extname(dep)) {
    const isJSFile = ['.js', '.mjs', '.cjs'].includes(path.extname(dep));
    return {
      type: isJSFile ? 'JS' : 'ASSET',
      loc: resolveFrom(cwd, dep),
    };
  }

  const depManifestLoc = resolveFrom(cwd, `${dep}/package.json`);
  const depManifest = require(depManifestLoc);
  let foundEntrypoint: string =
    depManifest['browser:module'] || depManifest.module || depManifest.browser;
  // If the package was a part of the explicit whitelist, fallback to it's main CJS entrypoint.
  if (!foundEntrypoint && isExplicit) {
    foundEntrypoint = depManifest.main || 'index.js';
  }
  if (!foundEntrypoint) {
    throw new ErrorWithHint(
      `dependency "${dep}" has no native "module" entrypoint.`,
      chalk.italic(
        `Tip: Find modern, web-ready packages at ${chalk.underline('https://www.pika.dev')}`,
      ),
    );
  }
  if (dep === 'react' && foundEntrypoint === 'index.js') {
    throw new ErrorWithHint(
      `dependency "react" has no native "module" entrypoint.`,
      chalk.italic(`See: ${chalk.underline('https://github.com/pikapkg/web#a-note-on-react')}`),
    );
  }
  return {
    type: 'JS',
    loc: path.join(depManifestLoc, '..', foundEntrypoint),
  };
}

/**
 * Formats the @pika/web dependency name from a "webDependencies" input value:
 * 2. Remove any ".js"/".mjs" extension (will be added automatically by Rollup)
 */
function getWebDependencyName(dep: string): string {
  return dep.replace(/\.m?js$/i, '');
}

export async function install(
  installTargets: InstallTarget[],
  {
    isCleanInstall,
    destLoc,
    hasBrowserlistConfig,
    isExplicit,
    isStrict,
    isBabel,
    isOptimized,
    sourceMap,
    namedExports,
    remoteUrl,
    remotePackages,
    dedupe,
  }: InstallOptions,
) {
  const knownNamedExports = {...namedExports};
  for (const filePath of PACKAGES_TO_AUTO_DETECT_EXPORTS) {
    knownNamedExports[filePath] = knownNamedExports[filePath] || detectExports(filePath) || [];
  }
  if (installTargets.length === 0) {
    logError('Nothing to install.');
    return;
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    logError('no "node_modules" directory exists. Did you run "npm install" first?');
    return;
  }
  if (isCleanInstall) {
    rimraf.sync(destLoc);
  }

  const allInstallSpecifiers = new Set(installTargets.map(dep => dep.specifier));
  const depObject: {[targetName: string]: string} = {};
  const assetObject: {[targetName: string]: string} = {};
  const importMap = {};
  const installTargetsMap = {};
  const skipFailures = !isExplicit;
  for (const installSpecifier of allInstallSpecifiers) {
    try {
      const targetName = getWebDependencyName(installSpecifier);
      const {type: targetType, loc: targetLoc} = resolveWebDependency(installSpecifier, isExplicit);
      if (targetType === 'JS') {
        depObject[targetName] = targetLoc;
        importMap[targetName] = `./${targetName}.js`;
        installTargetsMap[targetLoc] = installTargets.filter(t => installSpecifier === t.specifier);
        installResults.push([installSpecifier, true]);
      } else if (targetType === 'ASSET') {
        assetObject[targetName] = targetLoc;
        installResults.push([installSpecifier, true]);
      }
      spinner.text = banner + formatInstallResults(skipFailures);
    } catch (err) {
      installResults.push([installSpecifier, false]);
      spinner.text = banner + formatInstallResults(skipFailures);
      if (skipFailures) {
        continue;
      }
      // An error occurred! Log it.
      logError(err.message || err);
      if (err.hint) {
        console.log(err.hint);
      }
      return false;
    }
  }

  if (Object.keys(depObject).length === 0 && Object.keys(assetObject).length === 0) {
    logError(`No ESM dependencies found!`);
    console.log(
      chalk.dim(
        `  At least one dependency must have an ESM "module" entrypoint. You can find modern, web-ready packages at ${chalk.underline(
          'https://www.pika.dev',
        )}`,
      ),
    );
    return false;
  }

  if (Object.keys(depObject).length > 0) {
    const inputOptions = {
      input: depObject,
      plugins: [
        !isStrict &&
          rollupPluginReplace({
            'process.env.NODE_ENV': isOptimized ? '"production"' : '"development"',
          }),
        remoteUrl && rollupPluginRemoteResolve({remoteUrl, remotePackages}),
        rollupPluginNodeResolve({
          mainFields: ['browser:module', 'module', 'browser', !isStrict && 'main'].filter(Boolean),
          modulesOnly: isStrict, // Default: false
          extensions: ['.mjs', '.cjs', '.js', '.json'], // Default: [ '.mjs', '.js', '.json', '.node' ]
          // whether to prefer built-in modules (e.g. `fs`, `path`) or local ones with the same names
          preferBuiltins: false, // Default: true
          dedupe: dedupe,
        }),
        !isStrict &&
          rollupPluginJson({
            preferConst: true,
            indent: '  ',
          }),
        !isStrict &&
          rollupPluginCommonjs({
            extensions: ['.js', '.cjs'], // Default: [ '.js' ]
            namedExports: knownNamedExports,
          }),
        !!isBabel &&
          rollupPluginBabel({
            compact: false,
            babelrc: false,
            presets: [
              [
                babelPresetEnv,
                {
                  modules: false,
                  targets: hasBrowserlistConfig ? undefined : '>0.75%, not ie 11, not op_mini all',
                },
              ],
            ],
          }),
        !!isOptimized && rollupPluginTreeshakeInputs(installTargets),
        !!isOptimized && rollupPluginTerser(),
      ],
      onwarn: ((warning, warn) => {
        if (warning.code === 'UNRESOLVED_IMPORT') {
          // If we're using remoteUrl, we should expect them to be unresolved. ("external" should handle this for us, but we're still seeing it)
          if (remoteUrl && warning.source.startsWith(remoteUrl)) {
            return;
          }
          logError(
            `'${warning.source}' is imported by '${warning.importer}', but could not be resolved.`,
          );
          if (isNodeBuiltin(warning.source)) {
            console.log(
              chalk.dim(
                `  '${
                  warning.source
                }' is a Node.js builtin module that won't exist on the web. You can find modern, web-ready packages at ${chalk.underline(
                  'https://www.pika.dev',
                )}`,
              ),
            );
          } else {
            console.log(
              chalk.dim(`  Make sure that the package is installed and that the file exists.`),
            );
          }
          return;
        }
        warn(warning);
      }) as any,
    };
    const outputOptions = {
      dir: destLoc,
      format: 'esm' as 'esm',
      sourcemap: sourceMap === undefined ? isOptimized : sourceMap,
      exports: 'named' as 'named',
      chunkFileNames: 'common/[name]-[hash].js',
    };
    const packageBundle = await rollup.rollup(inputOptions);
    await packageBundle.write(outputOptions);
    fs.writeFileSync(
      path.join(destLoc, 'import-map.json'),
      JSON.stringify({imports: importMap}, undefined, 2),
      {encoding: 'utf8'},
    );
  }
  Object.entries(assetObject).forEach(([assetName, assetLoc]) => {
    mkdirp.sync(path.dirname(`${destLoc}/${assetName}`));
    fs.copyFileSync(assetLoc, `${destLoc}/${assetName}`);
  });
  return true;
}

export async function cli(args: string[]) {
  const {
    help,
    sourceMap,
    babel = false,
    optimize = false,
    include,
    strict = false,
    clean = false,
    dest = 'web_modules',
    remoteUrl = 'https://cdn.pika.dev',
    remotePackage: remotePackages = [],
  } = yargs(args);
  const destLoc = path.resolve(cwd, dest);

  if (help) {
    printHelp();
    process.exit(0);
  }

  const pkgManifest = require(path.join(cwd, 'package.json'));
  const implicitDependencies = [
    ...Object.keys(pkgManifest.dependencies || {}),
    ...Object.keys(pkgManifest.peerDependencies || {}),
  ];
  const allDependencies = [
    ...Object.keys(pkgManifest.dependencies || {}),
    ...Object.keys(pkgManifest.peerDependencies || {}),
    ...Object.keys(pkgManifest.devDependencies || {}),
  ];

  let isExplicit = false;
  const installTargets = [];
  const {namedExports, webDependencies, dedupe} = pkgManifest['@pika/web'] || {
    namedExports: undefined,
    webDependencies: undefined,
    dedupe: undefined,
  };

  if (webDependencies) {
    isExplicit = true;
    installTargets.push(...scanDepList(webDependencies, cwd));
  }
  if (include) {
    isExplicit = true;
    installTargets.push(...scanImports(include, allDependencies));
  }
  if (!webDependencies && !include) {
    installTargets.push(...scanDepList(implicitDependencies, cwd));
  }

  const hasBrowserlistConfig =
    !!pkgManifest.browserslist ||
    !!process.env.BROWSERSLIST ||
    fs.existsSync(path.join(cwd, '.browserslistrc')) ||
    fs.existsSync(path.join(cwd, 'browserslist'));

  spinner.start();
  const startTime = Date.now();
  const result = await install(installTargets, {
    isCleanInstall: clean,
    destLoc,
    namedExports,
    isExplicit,
    isStrict: strict,
    isBabel: babel || optimize,
    isOptimized: optimize,
    sourceMap,
    remoteUrl,
    hasBrowserlistConfig,
    remotePackages: remotePackages.map(p => p.split(',')),
    dedupe,
  });

  if (result) {
    spinner.succeed(
      chalk.bold(`@pika/web`) +
        ` installed: ` +
        formatInstallResults(!isExplicit) +
        '.' +
        (process.env.NODE_ENV === 'test'
          ? ''
          : chalk.dim(` [${((Date.now() - startTime) / 1000).toFixed(2)}s]`)),
    );
  }

  //If an error happened, set the exit code so that programmatic usage of the CLI knows.
  if (spinnerHasError) {
    spinner.warn(chalk(`Finished with warnings.`));
    process.exitCode = 1;
  }
}
