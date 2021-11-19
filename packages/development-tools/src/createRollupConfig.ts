import { DEFAULT_EXTENSIONS as DEFAULT_BABEL_EXTENSIONS } from '@babel/core'
import commonjs from '@rollup/plugin-commonjs'
import fs from 'fs'
import json from '@rollup/plugin-json'
import resolve, {
  DEFAULTS as RESOLVE_DEFAULTS,
} from '@rollup/plugin-node-resolve'
import path from 'path'
import { defineConfig, Plugin } from 'rollup'
import externalGlobals from 'rollup-plugin-external-globals'
import builtins from 'rollup-plugin-node-builtins'
import globals from 'rollup-plugin-node-globals'
import sourceMaps from 'rollup-plugin-sourcemaps'
import { terser } from 'rollup-plugin-terser'
import typescript from 'rollup-plugin-typescript2'
import ts from 'typescript'
import { babelPluginJBrowse } from './babelPluginJBrowse'
import { safePackageName, external } from './util'
import { RollupOptions } from 'rollup'
import nodeBuiltins from 'builtin-modules'

interface JBrowseRollupConfigOptions {
  includeUMD?: boolean
  includeCJS?: boolean
  includeESMBundle?: boolean
  includeNPM?: boolean
}

const appPath = fs.realpathSync(process.cwd())
const packageJsonPath = path.join(appPath, 'package.json')
const packageJsonText = fs.readFileSync(packageJsonPath, 'utf-8')
const packageJson = JSON.parse(packageJsonText)
const packageName = safePackageName(packageJson.name || '')
const umdName = `JBrowsePlugin${packageJson.config?.jbrowse?.plugin?.name}`

const distPath = path.join(appPath, 'dist')
const srcPath = path.join(appPath, 'src')

const tsconfigPath = 'tsconfig.json'
const tsconfigJSON = ts.readConfigFile(tsconfigPath, ts.sys.readFile).config
const tsCompilerOptions = ts.parseJsonConfigFileContent(
  tsconfigJSON,
  ts.sys,
  './',
).options

function createGlobalMap(jbrowseGlobals: string[], dotSyntax = false) {
  const globalMap: Record<string, string> = {}
  jbrowseGlobals.forEach(global => {
    if (dotSyntax) {
      globalMap[global] = `JBrowseExports.${global}`
    } else {
      globalMap[global] = `JBrowseExports["${global}"]`
    }
  })
  return globalMap
}

function getPlugins(
  mode: 'umd' | 'cjs' | 'npm' | 'esmBundle',
  jbrowseGlobals: string[],
): Plugin[] {
  return [
    resolve({
      mainFields: ['module', 'main', 'browser'],
      extensions: [...RESOLVE_DEFAULTS.extensions, '.jsx'],
      preferBuiltins: false,
    }),
    // all bundled external modules need to be converted from CJS to ESM
    commonjs({
      // use a regex to make sure to include eventual hoisted packages
      include:
        mode === 'umd' || mode === 'esmBundle' || mode === 'cjs'
          ? /\/node_modules\//
          : /\/regenerator-runtime\//,
    }),
    json(),
    typescript({
      typescript: ts,
      tsconfig: tsconfigPath,
      tsconfigDefaults: {
        exclude: [
          // all TS test files, regardless whether co-located or in test/ etc
          '**/*.spec.ts',
          '**/*.test.ts',
          '**/*.spec.tsx',
          '**/*.test.tsx',
          // TS defaults below
          'node_modules',
          'bower_components',
          'jspm_packages',
          distPath,
        ],
        compilerOptions: {
          sourceMap: true,
          declaration: true,
          jsx: 'react',
        },
      },
      tsconfigOverride: {
        compilerOptions: {
          // TS -> esnext, then leave the rest to babel-preset-env
          target: 'esnext',
          ...(mode === 'esmBundle' || mode === 'umd'
            ? { declaration: false, declarationMap: false }
            : {}),
        },
      },
      check: true,
      useTsconfigDeclarationDir: Boolean(tsCompilerOptions?.declarationDir),
    }),
    (mode === 'cjs' || mode === 'esmBundle') &&
      externalGlobals(createGlobalMap(jbrowseGlobals)),
    babelPluginJBrowse({
      exclude: 'node_modules/**',
      extensions: [...DEFAULT_BABEL_EXTENSIONS, 'ts', 'tsx'],
      // @ts-ignore
      custom: {
        extractErrors: false,
        format: mode === 'esmBundle' || mode === 'npm' ? 'esm' : mode,
      },
      babelHelpers: 'bundled',
    }),
    mode === 'npm' && sourceMaps(),
    mode === 'npm' && {
      name: 'write-index-file',
      generateBundle() {
        const baseLine = `module.exports = require('./${packageName}`
        const contents = `'use strict'

if (process.env.NODE_ENV === 'production') {
  ${baseLine}.cjs.production.min.js')
} else {
  ${baseLine}.cjs.development.js')
}
`
        if (!fs.existsSync(distPath)) {
          fs.mkdirSync(distPath, { recursive: true })
        }
        return fs.writeFileSync(path.join(distPath, 'index.js'), contents)
      },
    },

    (mode === 'esmBundle' || mode === 'umd') && globals(),
    (mode === 'esmBundle' || mode === 'umd') && builtins(),
  ].filter(Boolean)
}

export function createRollupConfig(
  jbrowseGlobals: string[],
  options?: JBrowseRollupConfigOptions,
) {
  const includeUMD = Boolean(
    options?.includeUMD === true || options?.includeUMD === undefined,
  )
  const includeCJS = Boolean(options?.includeCJS === true)
  const includeESMBundle = Boolean(options?.includeESMBundle === true)
  const includeNPM = Boolean(
    options?.includeNPM === true || options?.includeNPM === undefined,
  )
  const npmConfig =
    includeNPM &&
    defineConfig({
      input: path.join(srcPath, 'index.ts'),
      external,
      treeshake: { propertyReadSideEffects: false },
      plugins: getPlugins('npm', jbrowseGlobals),
      output: [
        {
          file: path.join(distPath, 'index.esm.js'),
          format: 'esm',
          freeze: false,
          esModule: true,
          sourcemap: true,
          exports: 'named',
        },
        {
          file: path.join(distPath, `${packageName}.cjs.development.js`),
          format: 'cjs',
          freeze: false,
          esModule: true,
          sourcemap: true,
          exports: 'named',
        },
        {
          file: path.join(distPath, `${packageName}.cjs.production.min.js`),
          format: 'cjs',
          freeze: false,
          esModule: true,
          sourcemap: true,
          exports: 'named',
          plugins: [
            terser({
              output: { comments: false },
              compress: { keep_infinity: true, pure_getters: true, passes: 10 },
              ecma: 5,
              toplevel: true,
            }),
          ],
        },
      ],
    })
  const umdConfig =
    includeUMD &&
    defineConfig({
      input: path.join(srcPath, 'index.ts'),
      external: (id: string) => {
        const isExternal = external(id)
        if (isExternal) {
          if (!jbrowseGlobals.includes(id)) {
            return false
          }
        }
        return isExternal
      },
      treeshake: { propertyReadSideEffects: false },
      plugins: getPlugins('umd', jbrowseGlobals),
      output: [
        {
          file: path.join(distPath, `${packageName}.umd.development.js`),
          format: 'umd',
          name: umdName,
          freeze: false,
          esModule: true,
          sourcemap: true,
          exports: 'named',
          globals: createGlobalMap(jbrowseGlobals, true),
        },
        {
          file: path.join(distPath, `${packageName}.umd.production.min.js`),
          format: 'umd',
          name: umdName,
          freeze: false,
          esModule: true,
          sourcemap: true,
          exports: 'named',
          globals: createGlobalMap(jbrowseGlobals, true),
          plugins: [
            terser({
              output: { comments: false },
              compress: { keep_infinity: true, pure_getters: true, passes: 10 },
              ecma: 5,
              toplevel: true,
            }),
          ],
        },
      ],
      watch: { clearScreen: false },
    })
  const esmBundleConfig =
    includeESMBundle &&
    defineConfig({
      input: path.join(srcPath, 'index.ts'),
      external: (id: string) => {
        const isExternal = external(id)
        if (isExternal) {
          if (!jbrowseGlobals.includes(id)) {
            return false
          }
        }
        return isExternal
      },
      treeshake: { propertyReadSideEffects: false },
      plugins: getPlugins('esmBundle', jbrowseGlobals),
      output: [
        {
          file: path.join(distPath, `${packageName}.esm.js`),
          format: 'esm',
          freeze: false,
          esModule: true,
          exports: 'named',
        },
      ],
      watch: { clearScreen: false },
    })
  const cjsConfig =
    includeCJS &&
    defineConfig({
      input: path.join(srcPath, 'index.ts'),
      external: (id: string) => {
        if (nodeBuiltins.includes(id)) {
          return true
        }
        const isExternal = external(id)
        if (isExternal) {
          if (!jbrowseGlobals.includes(id)) {
            return false
          }
        }
        return isExternal
      },
      treeshake: { propertyReadSideEffects: false },
      plugins: getPlugins('cjs', jbrowseGlobals),
      output: [
        {
          file: path.join(distPath, `${packageName}.cjs.js`),
          format: 'cjs',
          freeze: false,
          esModule: true,
          exports: 'named',
        },
      ],
      watch: { clearScreen: false },
    })
  const configs: RollupOptions[] = []
  ;[umdConfig, esmBundleConfig, npmConfig, cjsConfig].forEach(conf => {
    if (conf) {
      configs.push(conf)
    }
  })
  return defineConfig(configs)
}