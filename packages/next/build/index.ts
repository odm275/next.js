import crypto from 'crypto'
import fs from 'fs'
import Worker from 'jest-worker'
import chalk from 'next/dist/compiled/chalk'
import devalue from 'next/dist/compiled/devalue'
import escapeStringRegexp from 'next/dist/compiled/escape-string-regexp'
import findUp from 'next/dist/compiled/find-up'
import nanoid from 'next/dist/compiled/nanoid/index.js'
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp'
import path from 'path'
import { promisify } from 'util'
import formatWebpackMessages from '../client/dev/error-overlay/format-webpack-messages'
import checkCustomRoutes, {
  getRedirectStatus,
  Header,
  Redirect,
  Rewrite,
  RouteType,
} from '../lib/check-custom-routes'
import {
  PAGES_404_GET_INITIAL_PROPS_ERROR,
  PUBLIC_DIR_MIDDLEWARE_CONFLICT,
} from '../lib/constants'
import { findPagesDir } from '../lib/find-pages-dir'
import { loadEnvConfig } from '../lib/load-env-config'
import { recursiveDelete } from '../lib/recursive-delete'
import { recursiveReadDir } from '../lib/recursive-readdir'
import { verifyTypeScriptSetup } from '../lib/verifyTypeScriptSetup'
import {
  BUILD_MANIFEST,
  CLIENT_STATIC_FILES_PATH,
  EXPORT_DETAIL,
  EXPORT_MARKER,
  PAGES_MANIFEST,
  PHASE_PRODUCTION_BUILD,
  PRERENDER_MANIFEST,
  ROUTES_MANIFEST,
  SERVERLESS_DIRECTORY,
  SERVER_DIRECTORY,
} from '../next-server/lib/constants'
import {
  getRouteRegex,
  getSortedRoutes,
  isDynamicRoute,
} from '../next-server/lib/router/utils'
import { __ApiPreviewProps } from '../next-server/server/api-utils'
import loadConfig, {
  isTargetLikeServerless,
} from '../next-server/server/config'
import { normalizePagePath } from '../next-server/server/normalize-page-path'
import * as ciEnvironment from '../telemetry/ci-info'
import {
  eventBuildCompleted,
  eventBuildOptimize,
  eventCliSession,
  eventNextPlugins,
} from '../telemetry/events'
import { Telemetry } from '../telemetry/storage'
import { CompilerResult, runCompiler } from './compiler'
import { createEntrypoints, createPagesMapping } from './entries'
import { generateBuildId } from './generate-build-id'
import { isWriteable } from './is-writeable'
import createSpinner from './spinner'
import {
  collectPages,
  getJsPageSizeInKb,
  hasCustomGetInitialProps,
  isPageStatic,
  PageInfo,
  printCustomRoutes,
  printTreeView,
} from './utils'
import getBaseWebpackConfig from './webpack-config'
import { writeBuildId } from './write-build-id'

const fsAccess = promisify(fs.access)
const fsUnlink = promisify(fs.unlink)
const fsRmdir = promisify(fs.rmdir)
const fsStat = promisify(fs.stat)
const fsMove = promisify(fs.rename)
const fsReadFile = promisify(fs.readFile)
const fsWriteFile = promisify(fs.writeFile)
const mkdir = promisify(fs.mkdir)

const staticCheckWorker = require.resolve('./utils')

export type SsgRoute = {
  initialRevalidateSeconds: number | false
  srcRoute: string | null
  dataRoute: string
}

export type DynamicSsgRoute = {
  routeRegex: string
  fallback: string | false
  dataRoute: string
  dataRouteRegex: string
}

export type PrerenderManifest = {
  version: 2
  routes: { [route: string]: SsgRoute }
  dynamicRoutes: { [route: string]: DynamicSsgRoute }
  preview: __ApiPreviewProps
}

export default async function build(dir: string, conf = null): Promise<void> {
  if (!(await isWriteable(dir))) {
    throw new Error(
      '> Build directory is not writeable. https://err.sh/zeit/next.js/build-dir-not-writeable'
    )
  }

  // attempt to load global env values so they are available in next.config.js
  loadEnvConfig(dir)

  const config = loadConfig(PHASE_PRODUCTION_BUILD, dir, conf)
  const { target } = config
  const buildId = await generateBuildId(config.generateBuildId, nanoid)
  const distDir = path.join(dir, config.distDir)
  const headers: Header[] = []
  const rewrites: Rewrite[] = []
  const redirects: Redirect[] = []

  if (typeof config.experimental.redirects === 'function') {
    const _redirects = await config.experimental.redirects()
    checkCustomRoutes(_redirects, 'redirect')
    redirects.push(..._redirects)
  }
  if (typeof config.experimental.rewrites === 'function') {
    const _rewrites = await config.experimental.rewrites()
    checkCustomRoutes(_rewrites, 'rewrite')
    rewrites.push(..._rewrites)
  }
  if (typeof config.experimental.headers === 'function') {
    const _headers = await config.experimental.headers()
    checkCustomRoutes(_headers, 'header')
    headers.push(..._headers)
  }

  if (ciEnvironment.isCI) {
    const cacheDir = path.join(distDir, 'cache')
    const hasCache = await fsAccess(cacheDir)
      .then(() => true)
      .catch(() => false)

    if (!hasCache) {
      // Intentionally not piping to stderr in case people fail in CI when
      // stderr is detected.
      console.log(
        chalk.bold.yellow(`Warning: `) +
          chalk.bold(
            `No build cache found. Please configure build caching for faster rebuilds. Read more: https://err.sh/next.js/no-cache`
          )
      )
      console.log('')
    }
  }

  const buildSpinner = createSpinner({
    prefixText: 'Creating an optimized production build',
  })

  const telemetry = new Telemetry({ distDir })

  const publicDir = path.join(dir, 'public')
  const pagesDir = findPagesDir(dir)
  let publicFiles: string[] = []
  let hasPublicDir = false

  telemetry.record(
    eventCliSession(PHASE_PRODUCTION_BUILD, dir, {
      cliCommand: 'build',
      isSrcDir: path.relative(dir, pagesDir!).startsWith('src'),
      hasNowJson: !!(await findUp('now.json', { cwd: dir })),
      isCustomServer: null,
    })
  )

  eventNextPlugins(path.resolve(dir)).then(events => telemetry.record(events))

  await verifyTypeScriptSetup(dir, pagesDir)

  try {
    await fsStat(publicDir)
    hasPublicDir = true
  } catch (_) {}

  if (hasPublicDir) {
    publicFiles = await recursiveReadDir(publicDir, /.*/)
  }

  let tracer: any = null
  if (config.experimental.profiling) {
    const { createTrace } = require('./profiler/profiler.js')
    tracer = createTrace(path.join(distDir, `profile-events.json`))
    tracer.profiler.startProfiling()
  }

  const isLikeServerless = isTargetLikeServerless(target)

  const pagePaths: string[] = await collectPages(
    pagesDir,
    config.pageExtensions
  )

  // needed for static exporting since we want to replace with HTML
  // files
  const allStaticPages = new Set<string>()
  let allPageInfos = new Map<string, PageInfo>()

  const previewProps: __ApiPreviewProps = {
    previewModeId: crypto.randomBytes(16).toString('hex'),
    previewModeSigningKey: crypto.randomBytes(32).toString('hex'),
    previewModeEncryptionKey: crypto.randomBytes(32).toString('hex'),
  }

  const mappedPages = createPagesMapping(pagePaths, config.pageExtensions)
  const entrypoints = createEntrypoints(
    /* dev */ false,
    mappedPages,
    target,
    buildId,
    previewProps,
    config
  )
  const pageKeys = Object.keys(mappedPages)
  const dynamicRoutes = pageKeys.filter(page => isDynamicRoute(page))
  const conflictingPublicFiles: string[] = []
  const hasCustomErrorPage = mappedPages['/_error'].startsWith(
    'private-next-pages'
  )
  const hasPages404 = Boolean(
    mappedPages['/404'] && mappedPages['/404'].startsWith('private-next-pages')
  )
  let hasNonStaticErrorPage: boolean

  if (hasPublicDir) {
    try {
      await fsStat(path.join(publicDir, '_next'))
      throw new Error(PUBLIC_DIR_MIDDLEWARE_CONFLICT)
    } catch (err) {}
  }

  for (let file of publicFiles) {
    file = file
      .replace(/\\/g, '/')
      .replace(/\/index$/, '')
      .split(publicDir)
      .pop()!

    if (mappedPages[file]) {
      conflictingPublicFiles.push(file)
    }
  }
  const numConflicting = conflictingPublicFiles.length

  if (numConflicting) {
    throw new Error(
      `Conflicting public and page file${
        numConflicting === 1 ? ' was' : 's were'
      } found. https://err.sh/zeit/next.js/conflicting-public-file-page\n${conflictingPublicFiles.join(
        '\n'
      )}`
    )
  }

  const buildCustomRoute = (
    r: {
      source: string
      statusCode?: number
    },
    type: RouteType
  ) => {
    const keys: any[] = []
    const routeRegex = pathToRegexp(r.source, keys, {
      strict: true,
      sensitive: false,
      delimiter: '/', // default is `/#?`, but Next does not pass query info
    })

    return {
      ...r,
      ...(type === 'redirect'
        ? {
            statusCode: getRedirectStatus(r as Redirect),
            permanent: undefined,
          }
        : {}),
      regex: routeRegex.source,
    }
  }

  const routesManifestPath = path.join(distDir, ROUTES_MANIFEST)
  const routesManifest: any = {
    version: 1,
    pages404: true,
    basePath: config.experimental.basePath,
    redirects: redirects.map(r => buildCustomRoute(r, 'redirect')),
    rewrites: rewrites.map(r => buildCustomRoute(r, 'rewrite')),
    headers: headers.map(r => buildCustomRoute(r, 'header')),
    dynamicRoutes: getSortedRoutes(dynamicRoutes).map(page => ({
      page,
      regex: getRouteRegex(page).re.source,
    })),
  }

  await mkdir(distDir, { recursive: true })
  // We need to write the manifest with rewrites before build
  // so serverless can import the manifest
  await fsWriteFile(routesManifestPath, JSON.stringify(routesManifest), 'utf8')

  const configs = await Promise.all([
    getBaseWebpackConfig(dir, {
      tracer,
      buildId,
      isServer: false,
      config,
      target,
      pagesDir,
      entrypoints: entrypoints.client,
    }),
    getBaseWebpackConfig(dir, {
      tracer,
      buildId,
      isServer: true,
      config,
      target,
      pagesDir,
      entrypoints: entrypoints.server,
    }),
  ])

  const clientConfig = configs[0]

  if (
    clientConfig.optimization &&
    (clientConfig.optimization.minimize !== true ||
      (clientConfig.optimization.minimizer &&
        clientConfig.optimization.minimizer.length === 0))
  ) {
    console.warn(
      chalk.bold.yellow(`Warning: `) +
        chalk.bold(
          `Production code optimization has been disabled in your project. Read more: https://err.sh/zeit/next.js/minification-disabled`
        )
    )
  }

  const webpackBuildStart = process.hrtime()

  let result: CompilerResult = { warnings: [], errors: [] }
  // TODO: why do we need this?? https://github.com/zeit/next.js/issues/8253
  if (isLikeServerless) {
    const clientResult = await runCompiler(clientConfig)
    // Fail build if clientResult contains errors
    if (clientResult.errors.length > 0) {
      result = {
        warnings: [...clientResult.warnings],
        errors: [...clientResult.errors],
      }
    } else {
      const serverResult = await runCompiler(configs[1])
      result = {
        warnings: [...clientResult.warnings, ...serverResult.warnings],
        errors: [...clientResult.errors, ...serverResult.errors],
      }
    }
  } else {
    result = await runCompiler(configs)
  }

  const webpackBuildEnd = process.hrtime(webpackBuildStart)
  if (buildSpinner) {
    buildSpinner.stopAndPersist()
  }
  console.log()

  result = formatWebpackMessages(result)

  if (result.errors.length > 0) {
    // Only keep the first error. Others are often indicative
    // of the same problem, but confuse the reader with noise.
    if (result.errors.length > 1) {
      result.errors.length = 1
    }
    const error = result.errors.join('\n\n')

    console.error(chalk.red('Failed to compile.\n'))

    if (
      error.indexOf('private-next-pages') > -1 &&
      error.indexOf('does not contain a default export') > -1
    ) {
      const page_name_regex = /'private-next-pages\/(?<page_name>[^']*)'/
      const parsed = page_name_regex.exec(error)
      const page_name = parsed && parsed.groups && parsed.groups.page_name
      throw new Error(
        `webpack build failed: found page without a React Component as default export in pages/${page_name}\n\nSee https://err.sh/zeit/next.js/page-without-valid-component for more info.`
      )
    }

    console.error(error)
    console.error()

    if (
      error.indexOf('private-next-pages') > -1 ||
      error.indexOf('__next_polyfill__') > -1
    ) {
      throw new Error(
        '> webpack config.resolve.alias was incorrectly overriden. https://err.sh/zeit/next.js/invalid-resolve-alias'
      )
    }
    throw new Error('> Build failed because of webpack errors')
  } else {
    telemetry.record(
      eventBuildCompleted(pagePaths, {
        durationInSeconds: webpackBuildEnd[0],
      })
    )

    if (result.warnings.length > 0) {
      console.warn(chalk.yellow('Compiled with warnings.\n'))
      console.warn(result.warnings.join('\n\n'))
      console.warn()
    } else {
      console.log(chalk.green('Compiled successfully.\n'))
    }
  }
  const postBuildSpinner = createSpinner({
    prefixText: 'Automatically optimizing pages',
  })

  const manifestPath = path.join(
    distDir,
    isLikeServerless ? SERVERLESS_DIRECTORY : SERVER_DIRECTORY,
    PAGES_MANIFEST
  )
  const buildManifestPath = path.join(distDir, BUILD_MANIFEST)

  const ssgPages = new Set<string>()
  const ssgFallbackPages = new Set<string>()
  const staticPages = new Set<string>()
  const invalidPages = new Set<string>()
  const hybridAmpPages = new Set<string>()
  const serverPropsPages = new Set<string>()
  const additionalSsgPaths = new Map<string, Array<string>>()
  const pageInfos = new Map<string, PageInfo>()
  const pagesManifest = JSON.parse(await fsReadFile(manifestPath, 'utf8'))
  const buildManifest = JSON.parse(await fsReadFile(buildManifestPath, 'utf8'))

  let customAppGetInitialProps: boolean | undefined

  process.env.NEXT_PHASE = PHASE_PRODUCTION_BUILD

  const staticCheckWorkers = new Worker(staticCheckWorker, {
    numWorkers: config.experimental.cpus,
    enableWorkerThreads: config.experimental.workerThreads,
  }) as Worker & { isPageStatic: typeof isPageStatic }

  staticCheckWorkers.getStdout().pipe(process.stdout)
  staticCheckWorkers.getStderr().pipe(process.stderr)

  const runtimeEnvConfig = {
    publicRuntimeConfig: config.publicRuntimeConfig,
    serverRuntimeConfig: config.serverRuntimeConfig,
  }

  hasNonStaticErrorPage =
    hasCustomErrorPage &&
    (await hasCustomGetInitialProps(
      path.join(
        distDir,
        ...(isLikeServerless
          ? ['serverless', 'pages']
          : ['server', 'static', buildId, 'pages']),
        '_error.js'
      ),
      runtimeEnvConfig
    ))

  const analysisBegin = process.hrtime()
  await Promise.all(
    pageKeys.map(async page => {
      const actualPage = normalizePagePath(page)
      const [selfSize, allSize] = await getJsPageSizeInKb(
        actualPage,
        distDir,
        buildId,
        buildManifest,
        config.experimental.modern
      )
      const bundleRelative = path.join(
        isLikeServerless ? 'pages' : `static/${buildId}/pages`,
        actualPage + '.js'
      )
      const serverBundle = path.join(
        distDir,
        isLikeServerless ? SERVERLESS_DIRECTORY : SERVER_DIRECTORY,
        bundleRelative
      )

      let isSsg = false
      let isStatic = false
      let isHybridAmp = false
      let ssgPageRoutes: string[] | null = null
      let hasSsgFallback: boolean = false

      pagesManifest[page] = bundleRelative.replace(/\\/g, '/')

      const nonReservedPage = !page.match(/^\/(_app|_error|_document|api)/)

      if (nonReservedPage && customAppGetInitialProps === undefined) {
        customAppGetInitialProps = hasCustomGetInitialProps(
          isLikeServerless
            ? serverBundle
            : path.join(
                distDir,
                SERVER_DIRECTORY,
                `/static/${buildId}/pages/_app.js`
              ),
          runtimeEnvConfig
        )

        if (customAppGetInitialProps) {
          console.warn(
            chalk.bold.yellow(`Warning: `) +
              chalk.yellow(
                `You have opted-out of Automatic Static Optimization due to \`getInitialProps\` in \`pages/_app\`. This does not opt-out pages with \`getStaticProps\``
              )
          )
          console.warn(
            'Read more: https://err.sh/next.js/opt-out-auto-static-optimization\n'
          )
        }
      }

      if (nonReservedPage) {
        try {
          let result = await staticCheckWorkers.isPageStatic(
            page,
            serverBundle,
            runtimeEnvConfig
          )

          if (result.isHybridAmp) {
            isHybridAmp = true
            hybridAmpPages.add(page)
          }

          if (result.isAmpOnly) {
            // ensure all AMP only bundles got removed
            try {
              const clientBundle = path.join(
                distDir,
                'static',
                buildId,
                'pages',
                actualPage + '.js'
              )
              await fsUnlink(clientBundle)

              if (config.experimental.modern) {
                await fsUnlink(clientBundle.replace(/\.js$/, '.module.js'))
              }
            } catch (err) {
              if (err.code !== 'ENOENT') {
                throw err
              }
            }
          }

          if (result.hasStaticProps) {
            ssgPages.add(page)
            isSsg = true

            if (result.prerenderRoutes) {
              additionalSsgPaths.set(page, result.prerenderRoutes)
              ssgPageRoutes = result.prerenderRoutes
            }
            if (result.prerenderFallback) {
              hasSsgFallback = true
              ssgFallbackPages.add(page)
            }
          } else if (result.hasServerProps) {
            serverPropsPages.add(page)
          } else if (result.isStatic && customAppGetInitialProps === false) {
            staticPages.add(page)
            isStatic = true
          }

          if (hasPages404 && page === '/404') {
            if (!result.isStatic && !result.hasStaticProps) {
              throw new Error(PAGES_404_GET_INITIAL_PROPS_ERROR)
            }
            // we need to ensure the 404 lambda is present since we use
            // it when _app has getInitialProps
            if (customAppGetInitialProps && !result.hasStaticProps) {
              staticPages.delete(page)
            }
          }
        } catch (err) {
          if (err.message !== 'INVALID_DEFAULT_EXPORT') throw err
          invalidPages.add(page)
        }
      }

      pageInfos.set(page, {
        size: selfSize,
        totalSize: allSize,
        serverBundle,
        static: isStatic,
        isSsg,
        isHybridAmp,
        ssgPageRoutes,
        hasSsgFallback,
      })
    })
  )
  staticCheckWorkers.end()

  if (serverPropsPages.size > 0 || ssgPages.size > 0) {
    // We update the routes manifest after the build with the
    // data routes since we can't determine these until after build
    routesManifest.dataRoutes = getSortedRoutes([
      ...serverPropsPages,
      ...ssgPages,
    ]).map(page => {
      const pagePath = normalizePagePath(page)
      const dataRoute = path.posix.join(
        '/_next/data',
        buildId,
        `${pagePath}.json`
      )

      return {
        page,
        dataRouteRegex: isDynamicRoute(page)
          ? getRouteRegex(dataRoute.replace(/\.json$/, '')).re.source.replace(
              /\(\?:\\\/\)\?\$$/,
              '\\.json$'
            )
          : new RegExp(
              `^${path.posix.join(
                '/_next/data',
                escapeStringRegexp(buildId),
                `${pagePath}.json`
              )}$`
            ).source,
      }
    })

    await fsWriteFile(
      routesManifestPath,
      JSON.stringify(routesManifest),
      'utf8'
    )
  }
  // Since custom _app.js can wrap the 404 page we have to opt-out of static optimization if it has getInitialProps
  // Only export the static 404 when there is no /_error present
  const useStatic404 =
    !customAppGetInitialProps && (!hasNonStaticErrorPage || hasPages404)

  if (invalidPages.size > 0) {
    throw new Error(
      `Build optimization failed: found page${
        invalidPages.size === 1 ? '' : 's'
      } without a React Component as default export in \n${[...invalidPages]
        .map(pg => `pages${pg}`)
        .join(
          '\n'
        )}\n\nSee https://err.sh/zeit/next.js/page-without-valid-component for more info.\n`
    )
  }

  if (Array.isArray(configs[0].plugins)) {
    configs[0].plugins.some((plugin: any) => {
      if (!plugin.ampPages) {
        return false
      }

      plugin.ampPages.forEach((pg: any) => {
        pageInfos.get(pg)!.isAmp = true
      })
      return true
    })
  }

  await writeBuildId(distDir, buildId)

  const finalPrerenderRoutes: { [route: string]: SsgRoute } = {}
  const tbdPrerenderRoutes: string[] = []

  if (staticPages.size > 0 || ssgPages.size > 0 || useStatic404) {
    const combinedPages = [...staticPages, ...ssgPages]
    const exportApp = require('../export').default
    const exportOptions = {
      silent: true,
      buildExport: true,
      threads: config.experimental.cpus,
      pages: combinedPages,
      outdir: path.join(distDir, 'export'),
    }
    const exportConfig: any = {
      ...config,
      initialPageRevalidationMap: {},
      // Default map will be the collection of automatic statically exported
      // pages and SPR pages.
      // n.b. we cannot handle this above in combinedPages because the dynamic
      // page must be in the `pages` array, but not in the mapping.
      exportPathMap: (defaultMap: any) => {
        // Dynamically routed pages should be prerendered to be used as
        // a client-side skeleton (fallback) while data is being fetched.
        // This ensures the end-user never sees a 500 or slow response from the
        // server.
        //
        // Note: prerendering disables automatic static optimization.
        ssgPages.forEach(page => {
          if (isDynamicRoute(page)) {
            tbdPrerenderRoutes.push(page)

            if (ssgFallbackPages.has(page)) {
              // Override the rendering for the dynamic page to be treated as a
              // fallback render.
              defaultMap[page] = { page, query: { __nextFallback: true } }
            } else {
              // Remove dynamically routed pages from the default path map when
              // fallback behavior is disabled.
              delete defaultMap[page]
            }
          }
        })
        // Append the "well-known" routes we should prerender for, e.g. blog
        // post slugs.
        additionalSsgPaths.forEach((routes, page) => {
          routes.forEach(route => {
            defaultMap[route] = { page }
          })
        })

        if (useStatic404) {
          defaultMap['/404'] = {
            page: hasPages404 ? '/404' : '/_error',
          }
        }

        return defaultMap
      },
      exportTrailingSlash: false,
    }

    await exportApp(dir, exportOptions, exportConfig)

    // remove server bundles that were exported
    for (const page of staticPages) {
      const { serverBundle } = pageInfos.get(page)!
      await fsUnlink(serverBundle)
    }

    const moveExportedPage = async (
      page: string,
      file: string,
      isSsg: boolean,
      ext: 'html' | 'json'
    ) => {
      file = `${file}.${ext}`
      const orig = path.join(exportOptions.outdir, file)
      const relativeDest = (isLikeServerless
        ? path.join('pages', file)
        : path.join('static', buildId, 'pages', file)
      ).replace(/\\/g, '/')

      const dest = path.join(
        distDir,
        isLikeServerless ? SERVERLESS_DIRECTORY : SERVER_DIRECTORY,
        relativeDest
      )

      if (!isSsg) {
        pagesManifest[page] = relativeDest
        if (page === '/') pagesManifest['/index'] = relativeDest
        if (page === '/.amp') pagesManifest['/index.amp'] = relativeDest
      }
      await mkdir(path.dirname(dest), { recursive: true })
      await fsMove(orig, dest)
    }

    // Only move /404 to /404 when there is no custom 404 as in that case we don't know about the 404 page
    if (!hasPages404 && useStatic404) {
      await moveExportedPage('/404', '/404', false, 'html')
    }

    for (const page of combinedPages) {
      const isSsg = ssgPages.has(page)
      const isSsgFallback = ssgFallbackPages.has(page)
      const isDynamic = isDynamicRoute(page)
      const hasAmp = hybridAmpPages.has(page)
      let file = normalizePagePath(page)

      // The dynamic version of SSG pages are only prerendered if the fallback
      // is enabled. Below, we handle the specific prerenders of these.
      if (!(isSsg && isDynamic && !isSsgFallback)) {
        await moveExportedPage(page, file, isSsg, 'html')
      }

      if (hasAmp) {
        await moveExportedPage(`${page}.amp`, `${file}.amp`, isSsg, 'html')
      }

      if (isSsg) {
        // For a non-dynamic SSG page, we must copy its data file from export.
        if (!isDynamic) {
          await moveExportedPage(page, file, true, 'json')

          finalPrerenderRoutes[page] = {
            initialRevalidateSeconds:
              exportConfig.initialPageRevalidationMap[page],
            srcRoute: null,
            dataRoute: path.posix.join('/_next/data', buildId, `${file}.json`),
          }
        } else {
          // For a dynamic SSG page, we did not copy its data exports and only
          // copy the fallback HTML file (if present).
          // We must also copy specific versions of this page as defined by
          // `getStaticPaths` (additionalSsgPaths).
          const extraRoutes = additionalSsgPaths.get(page) || []
          for (const route of extraRoutes) {
            await moveExportedPage(route, route, true, 'html')
            await moveExportedPage(route, route, true, 'json')
            finalPrerenderRoutes[route] = {
              initialRevalidateSeconds:
                exportConfig.initialPageRevalidationMap[route],
              srcRoute: page,
              dataRoute: path.posix.join(
                '/_next/data',
                buildId,
                `${normalizePagePath(route)}.json`
              ),
            }
          }
        }
      }
    }

    // remove temporary export folder
    await recursiveDelete(exportOptions.outdir)
    await fsRmdir(exportOptions.outdir)
    await fsWriteFile(manifestPath, JSON.stringify(pagesManifest), 'utf8')
  }

  if (postBuildSpinner) postBuildSpinner.stopAndPersist()
  console.log()

  const analysisEnd = process.hrtime(analysisBegin)
  telemetry.record(
    eventBuildOptimize(pagePaths, {
      durationInSeconds: analysisEnd[0],
      staticPageCount: staticPages.size,
      staticPropsPageCount: ssgPages.size,
      serverPropsPageCount: serverPropsPages.size,
      ssrPageCount:
        pagePaths.length -
        (staticPages.size + ssgPages.size + serverPropsPages.size),
      hasStatic404: useStatic404,
    })
  )

  if (ssgPages.size > 0) {
    const finalDynamicRoutes: PrerenderManifest['dynamicRoutes'] = {}
    tbdPrerenderRoutes.forEach(tbdRoute => {
      const normalizedRoute = normalizePagePath(tbdRoute)
      const dataRoute = path.posix.join(
        '/_next/data',
        buildId,
        `${normalizedRoute}.json`
      )

      finalDynamicRoutes[tbdRoute] = {
        routeRegex: getRouteRegex(tbdRoute).re.source,
        dataRoute,
        fallback: ssgFallbackPages.has(tbdRoute)
          ? `${normalizedRoute}.html`
          : false,
        dataRouteRegex: getRouteRegex(
          dataRoute.replace(/\.json$/, '')
        ).re.source.replace(/\(\?:\\\/\)\?\$$/, '\\.json$'),
      }
    })
    const prerenderManifest: PrerenderManifest = {
      version: 2,
      routes: finalPrerenderRoutes,
      dynamicRoutes: finalDynamicRoutes,
      preview: previewProps,
    }

    await fsWriteFile(
      path.join(distDir, PRERENDER_MANIFEST),
      JSON.stringify(prerenderManifest),
      'utf8'
    )
    await generateClientSsgManifest(prerenderManifest, {
      distDir,
      buildId,
      isModern: !!config.experimental.modern,
    })
  } else {
    const prerenderManifest: PrerenderManifest = {
      version: 2,
      routes: {},
      dynamicRoutes: {},
      preview: previewProps,
    }
    await fsWriteFile(
      path.join(distDir, PRERENDER_MANIFEST),
      JSON.stringify(prerenderManifest),
      'utf8'
    )
    // No need to call this fn as we already emitted a default SSG manifest:
    // await generateClientSsgManifest(prerenderManifest, { distDir, buildId })
  }

  await fsWriteFile(
    path.join(distDir, EXPORT_MARKER),
    JSON.stringify({
      version: 1,
      hasExportPathMap: typeof config.exportPathMap === 'function',
      exportTrailingSlash: config.exportTrailingSlash === true,
    }),
    'utf8'
  )
  await fsUnlink(path.join(distDir, EXPORT_DETAIL)).catch(err => {
    if (err.code === 'ENOENT') {
      return Promise.resolve()
    }
    return Promise.reject(err)
  })

  staticPages.forEach(pg => allStaticPages.add(pg))
  pageInfos.forEach((info: PageInfo, key: string) => {
    allPageInfos.set(key, info)
  })

  await printTreeView(
    Object.keys(mappedPages),
    allPageInfos,
    isLikeServerless,
    {
      distPath: distDir,
      buildId: buildId,
      pagesDir,
      useStatic404,
      pageExtensions: config.pageExtensions,
      buildManifest,
      isModern: config.experimental.modern,
    }
  )
  printCustomRoutes({ redirects, rewrites, headers })

  if (tracer) {
    const parsedResults = await tracer.profiler.stopProfiling()
    await new Promise(resolve => {
      if (parsedResults === undefined) {
        tracer.profiler.destroy()
        tracer.trace.flush()
        tracer.end(resolve)
        return
      }

      const cpuStartTime = parsedResults.profile.startTime
      const cpuEndTime = parsedResults.profile.endTime

      tracer.trace.completeEvent({
        name: 'TaskQueueManager::ProcessTaskFromWorkQueue',
        id: ++tracer.counter,
        cat: ['toplevel'],
        ts: cpuStartTime,
        args: {
          src_file: '../../ipc/ipc_moji_bootstrap.cc',
          src_func: 'Accept',
        },
      })

      tracer.trace.completeEvent({
        name: 'EvaluateScript',
        id: ++tracer.counter,
        cat: ['devtools.timeline'],
        ts: cpuStartTime,
        dur: cpuEndTime - cpuStartTime,
        args: {
          data: {
            url: 'webpack',
            lineNumber: 1,
            columnNumber: 1,
            frame: '0xFFF',
          },
        },
      })

      tracer.trace.instantEvent({
        name: 'CpuProfile',
        id: ++tracer.counter,
        cat: ['disabled-by-default-devtools.timeline'],
        ts: cpuEndTime,
        args: {
          data: {
            cpuProfile: parsedResults.profile,
          },
        },
      })

      tracer.profiler.destroy()
      tracer.trace.flush()
      tracer.end(resolve)
    })
  }

  await telemetry.flush()
}

function generateClientSsgManifest(
  prerenderManifest: PrerenderManifest,
  {
    buildId,
    distDir,
    isModern,
  }: { buildId: string; distDir: string; isModern: boolean }
) {
  const ssgPages: Set<string> = new Set<string>([
    ...Object.entries(prerenderManifest.routes)
      // Filter out dynamic routes
      .filter(([, { srcRoute }]) => srcRoute == null)
      .map(([route]) => route),
    ...Object.keys(prerenderManifest.dynamicRoutes),
  ])

  const clientSsgManifestPaths = [
    '_ssgManifest.js',
    isModern && '_ssgManifest.module.js',
  ]
    .filter(Boolean)
    .map(f => path.join(`${CLIENT_STATIC_FILES_PATH}/${buildId}`, f as string))
  const clientSsgManifestContent = `self.__SSG_MANIFEST=${devalue(
    ssgPages
  )};self.__SSG_MANIFEST_CB&&self.__SSG_MANIFEST_CB()`
  clientSsgManifestPaths.forEach(clientSsgManifestPath =>
    fs.writeFileSync(
      path.join(distDir, clientSsgManifestPath),
      clientSsgManifestContent
    )
  )
}
