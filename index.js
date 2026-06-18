'use strict';

const { existsSync, readFileSync, mkdirSync, writeFileSync } = require('fs');
const { dirname, join } = require('path');
const { execSync } = require('child_process');
const { compareVersions, satisfies } = require('compare-versions');

const currentProjectRoot = process.cwd();
const isNpxRun = __dirname.indexOf(currentProjectRoot) === -1;
let outputConsole = false;

function detectPackageManager() {
  const userAgent = process.env.npm_config_user_agent;

  if (userAgent) {
    if (userAgent.includes('pnpm')) {
        return 'pnpm';
    } else if (userAgent.includes('npm')) {
        return 'npm';
    } else if (userAgent.includes('yarn')) {
        return 'yarn';
    }
  }

  return 'unknown';
}

// 当前使用的包管理器，npm/pnpm/yarn
const packageManager = detectPackageManager();

function getPackageLockfile() {
  if (packageManager === 'npm') {
    return 'package-lock.json';
  } else if (packageManager === 'pnpm') {
    return 'pnpm-lock.yaml';
  } else if (packageManager === 'yarn') {
    return 'yarn.lock';
  }
}

function logger(level, msg) {
  if (outputConsole) {
    if (level === 'error') {
      console.error(`\x1B[31m${msg}\x1B[0m`);
    } else if (level === 'warn') {
      console.error(`\x1B[33m${msg}\x1B[0m`);
    } else {
      console[level](msg);
    }
  }
}

function prettyOutput(messags = [], level = 'log') {
  let maxLen = 70;
  messags = Array.isArray(messags) ? messags : [messags];
  messags.forEach((msg) => {
    if (msg.length > maxLen) {
      maxLen = msg.length;
    }
  });

  logger('log', '*'.repeat(maxLen));
  messags.forEach(msg => {
    logger(level, msg);
  });
  logger('log', '*'.repeat(maxLen));
}

function outputError(err) {
  prettyOutput(typeof err === 'string' ? err : err.message, 'error');
}

function runCmd(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd: cwd || process.env.HOME,
    }).toString();
  } catch (err) {
    outputError([
      `"${cmd}" run failed, please re-run by yourself.`,
      `err=${err.stdout ? err.stdout.toString() : err.message}`
    ].join('\n'));
    process.exit(0);
  }
}

function getReplacedDepenciesVersion(pkgVersion, targetVersion, retentionPrefix = true) {
  if (pkgVersion === targetVersion) {
    return pkgVersion;
  }

  if (retentionPrefix) {
    // ^ 或者 ~ 打头的，保留该符号
    if (pkgVersion.startsWith('^') || pkgVersion.startsWith('~')) {
      return `${pkgVersion[0]}${targetVersion}`;
    }
  }

  return targetVersion;
}

function filterVersionPrefix(version) {
  if (version.startsWith('^') || version.startsWith('~')) {
    return version.slice(1);
  }
  return version;
}

/**
 * 获取实际安装的版本
 * @param {*} pkgName 
 * @param {*} resolveMode 
 * @param {*} options 
 * @returns 
 */
function getVersion(pkgName, resolveMode = true, options = {}) {
  options.cwd = options.cwd || currentProjectRoot;
  try {
    if (resolveMode) {
      return require(join(
        options.cwd,
        'node_modules',
        `${pkgName}/package.json`
      )).version;
    } else {
      return require(`${pkgName}/package.json`).version;
    }
  } catch (e) {
    return undefined;
  }
}

function getPkgVersion(pkgJSON, pkgName) {
  if (pkgJSON['dependencies'] && pkgJSON['dependencies'][pkgName]) {
    return {
      version: pkgJSON['dependencies'][pkgName],
      type: 'dependencies',
    };
  } else if (pkgJSON['devDependencies'] && pkgJSON['devDependencies'][pkgName]) {
    return {
      version: pkgJSON['devDependencies'][pkgName],
      type: 'devDependencies',
    }
  } else {
    return undefined;
  }
}

function getVersionFile(coreVersion, decoratorVersion, baseDir) {
  baseDir = baseDir || dirname(require.resolve('@midwayjs/version'));
  // 新版本 core 和 decorator 的版本应该是一样的
  decoratorVersion = decoratorVersion || coreVersion;
  let versionFile = join(
    baseDir,
    `versions/${decoratorVersion.replace(/\./g, '_')}-${coreVersion.replace(
      /\./g,
      '_'
    )}.json`
  );

  if (!existsSync(versionFile)) {
    // 修正一次
    versionFile = join(
      baseDir,
      `versions/${coreVersion.replace(/\./g, '_')}-${coreVersion.replace(
        /\./g,
        '_'
      )}.json`
    );
  }

  if (!existsSync(versionFile)) {
    logger('log', '*'.repeat(50));
    logger(
      'error',
      `>> Current version @midwayjs/decorator(${decoratorVersion}) and @midwayjs/core(${coreVersion}) not found in @midwayjs/version, please check it.`
    );
    logger('log', '*'.repeat(50));
    return;
  }
  return versionFile;
}

// 普通检查包依赖的版本是否错误
function checkVersion(coreVersion, externalVersions, options = {}) {
  const result = [];
  const versionFile = getVersionFile(coreVersion, getVersion('@midwayjs/decorator'));
  if (!versionFile) {
    return;
  }

  const text = readFileSync(versionFile, 'utf-8');
  const versions = Object.assign({}, JSON.parse(text), externalVersions);
  let fail = 0;
  logger('log', '>> Start to check your midway component version...\n');

  // 当前版本的包信息列表
  const pkgList = Object.keys(versions);

  for (const pkgName of pkgList) {
    const version = getVersion(pkgName);
    if (!version) {
      logger('info', `\x1B[32m✓\x1B[0m ${pkgName}(not installed)`);
      continue;
    }

    // 格式化 version 的版本列表，变为数组形式，从小到大排列
    versions[pkgName] = [].concat(versions[pkgName]);

    if (versions[pkgName].indexOf(version) !== -1) {
      // ok
      logger('info', `\x1B[32m✓\x1B[0m ${pkgName}(${version})`);
    } else {
      // 支持 semver 对比
      if (versions[pkgName].some((v) => satisfies(version, v))) {
        logger('info', `\x1B[32m✓\x1B[0m ${pkgName}(${version})`);
      } else {
        // fail
        fail++;
        result.push({
          name: pkgName,
          current: version,
          allow: versions[pkgName],
        });
        logger(
          'error',
          `\x1B[31m✖\x1B[0m ${pkgName}(current: ${version}, allow: ${JSON.stringify(
            versions[pkgName]
          )})`
        );
      }
    }
  }

  if (fail > 0) {
    prettyOutput([
      `>> Check complete, found \x1B[41m ${fail} \x1B[0m problem.`,
      `>> Use \x1B[36m\x1B[1m-u\x1B[0m to show update list that can be upgraded to the latest version.`,
      `>> Use \x1B[36m\x1B[1m-m\x1B[0m to show updates that can be upgraded to the most compatible version.`,
      `>> Use \x1B[36m\x1B[1m-u -w\x1B[0m or \x1B[36m\x1B[1m-m -w\x1B[0m to write to the package.json file and update the lock file if it exists.`,
      `>> Please check the result above.`
    ]);
  } else {
    prettyOutput([
      `>> Check complete, all versions are healthy.`,
    ]);
  }

  return result;
}

// 下载最新的包到 node_modules
function getLatestPackage(templateUri, baseDir, npmClient = 'npm') {
  let data = runCmd(`${npmClient} view ${templateUri} dist-tags --json`);
  const remoteVersion = JSON.parse(data)['latest'];

  function checkoutVersionEquals() {
    const midwayVersionPkgVersion = getVersion('@midwayjs/version', true, {
      cwd: baseDir,
    });
    return midwayVersionPkgVersion === remoteVersion;
  }

  if (!checkoutVersionEquals()) {
    // 如果 node_modules 不存在，则建一个
    if (!existsSync(join(baseDir, 'node_modules'))) {
      mkdirSync(join(baseDir, 'node_modules'));
    }
    // 如果版本不同，则需要重新安装
    runCmd(
      `${npmClient} pack @midwayjs/version --quiet --pack-destination=${join(
        baseDir,
        'node_modules'
      )}`
    );
    // 用 install 安装 zip 包
    runCmd(
      `${npmClient} install --quiet --no-save --no-package-lock ${join(
        baseDir,
        'node_modules',
        `midwayjs-version-${remoteVersion}.tgz`
      )}`,
      baseDir
    );

    if (!checkoutVersionEquals()) {
      outputError('@midwayjs/version install error and version is not equals');
    }
  }
}

// 检查包是否可以更新到最新版本
function checkPackageUpdate(externalVersions = {}, options = {}) {
  // 启用写入模式
  const writeUpdate = process.argv.includes('-w');
  // core 版本
  const currentCoreVersion = options.coreVersion || getVersion('@midwayjs/core');
  // 包括 pkg 没有的依赖
  const includePkgNotExists = process.argv.includes('--include-pkg-not-exists');
  // 是否兼容模式
  const isCompatibleMode = options.mode === 'compatible';
  // 是否包含 lock 文件
  const hasLockFile = existsSync(join(currentProjectRoot, getPackageLockfile()));

  if (!existsSync(join(currentProjectRoot, 'package.json'))) {
    outputError('>> Package.json not found in current cwd, please check it.');
    return;
  }

  const baseDir = join(
    dirname(require.resolve('@midwayjs/version')),
    '../../../'
  );
  const versionBaseDir = dirname(require.resolve('@midwayjs/version'));

  getLatestPackage('@midwayjs/version', baseDir, options.npmClient);

  let decoratorVersion, coreVersion;
  if (isCompatibleMode) {
    // 兼容模式，获取当前依赖中的版本
    decoratorVersion = getVersion('@midwayjs/decorator');
    coreVersion = currentCoreVersion;
  } else {
    const version = require('@midwayjs/version');
    decoratorVersion = version.decorator;
    coreVersion = version.core;
  }

  const result = [];
  const versionFile = getVersionFile(coreVersion, decoratorVersion, versionBaseDir);

  const text = readFileSync(versionFile, 'utf-8');
  const versions = Object.assign({}, JSON.parse(text), externalVersions);
  logger('log', '>> Start to check your midway component version...\n');

  // 当前版本的包信息列表
  const pkgList = Object.keys(versions);
  // package.json 的内容
  const pkgText = readFileSync(
    join(currentProjectRoot, 'package.json'),
    'utf-8'
  );
  let pkgJSON;
  try {
    pkgJSON = JSON.parse(pkgText);
  } catch (e) {
    outputError('>> >> Package.json parse error, please check it.');
    return;
  }

  const pkgDeps = {
    ...pkgJSON['dependencies'],
    ...pkgJSON['devDependencies'],
  };

  let fail = 0;

  // 把当前的实际依赖的包版本和 versions 文件中的版本进行对比
  for (const pkgName of pkgList) {
    const version = getVersion(pkgName);
    if (!version) {
      continue;
    }

    if (!pkgDeps[pkgName] && !includePkgNotExists) {
      // 如果 package.json 中不存在，则不需要检查
      continue;
    }

    // 格式化 version 的版本列表，变为数组形式，从小到大排列
    versions[pkgName] = [].concat(versions[pkgName]);

    // 拿到最新的版本
    const latestVersion = versions[pkgName].pop();

    if (latestVersion === version) {
      // 如果运行时版本相同，则检查 package.json 中的版本是否相同
      const pkgVersionInfo = getPkgVersion(pkgJSON, pkgName);
      if (pkgVersionInfo && !pkgVersionInfo.version.includes(latestVersion)) {
        // 说明这个依赖是自动升级的，仅需要更新 pkg
        fail++;
        result.push({
          name: pkgName,
          current: pkgVersionInfo.version,
          latestVersion,
        });
        if (pkgDeps[pkgName]) {
          // 依赖中存在
          logger(
            'error',
            `\x1b[33m▫️\x1B[0m ${pkgName.padEnd(40, ' ')}${filterVersionPrefix(pkgVersionInfo.version).padEnd(
              15,
              ' '
            )} => ${latestVersion.padEnd(15, ' ')}`
          );
        } else {
          // 依赖中不存在，文字变灰
          logger(
            'error',
            `\x1b[33m▫️\x1B[0m \x1B[2m${pkgName.padEnd(40, ' ')}${filterVersionPrefix(pkgVersionInfo.version).padEnd(
              15,
              ' '
            )} => ${latestVersion} (force include)\x1B[0m`
          );
        }
      }
    } else {
      // 说明这个依赖是 pkg 版本和实际安装的版本都需要升级
      fail++;
      result.push({
        name: pkgName,
        current: version,
        latestVersion,
      });
      if (pkgDeps[pkgName]) {
        logger(
          'error',
          `\x1b[33m▫️\x1B[0m ${pkgName.padEnd(40, ' ')}${version.padEnd(
            15,
            ' '
          )} => ${latestVersion.padEnd(15, ' ')}`
        );
      } else {
        // 依赖中不存在，文字变灰
        logger(
          'error',
          `\x1b[33m▫️\x1B[0m \x1B[2m${pkgName.padEnd(40, ' ')}${version.padEnd(
            15,
            ' '
          )} => ${latestVersion} (force include)\x1B[0m`
        );
      }
    }
  }

  if (isCompatibleMode && !hasLockFile && !result.find(r => r.name === '@midwayjs/core')) {
    // 兼容模式下，如果没有 lock 文件，则需要写死版本，如果上面没处理过 core，这里额外处理 @midwayjs/core
    result.push({
      name: '@midwayjs/core',
      current: currentCoreVersion,
      latestVersion: currentCoreVersion,
    });
  }

  if (writeUpdate) {
    if (result.length > 0) {
      const pkgVersion = [];
      // 循环 pkg，设置依赖版本
      for (const pkg of result) {
        if (!pkgDeps[pkg.name] && !includePkgNotExists) {
          // 如果 package.json 中不存在，且未配置强制包括不存在的依赖，则不需要更新
          continue;
        }
        pkgVersion.push(`${pkg.name}@${pkg.latestVersion}`);

        /**
         * 普通模式下，直接写入最新版本，保留原有格式
         * 兼容模式下，如果有 lock 文件，则保留原有格式，如果没有，则写死版本
         */
        const retentionPrefix = isCompatibleMode ? hasLockFile: true;
        if (pkgJSON['dependencies'][pkg.name]) {
          pkgJSON['dependencies'][pkg.name] = getReplacedDepenciesVersion(
            pkgJSON['dependencies'][pkg.name],
            pkg.latestVersion,
            retentionPrefix
          );
        } else if (pkgJSON['devDependencies'][pkg.name]) {
          pkgJSON['devDependencies'][pkg.name] = getReplacedDepenciesVersion(
            pkgJSON['devDependencies'][pkg.name],
            pkg.latestVersion,
            retentionPrefix
          );
        }
      }
      // 写入 package.json
      writeFileSync(
        join(currentProjectRoot, 'package.json'),
        JSON.stringify(pkgJSON, null, 2)
      );

      if (hasLockFile) {
        let installCmd;
        switch (packageManager) {
          case 'npm':
            installCmd = `npm install ${pkgVersion.join(' ')} --package-lock-only`;
            break;
          case 'pnpm':
            installCmd = `pnpm install ${pkgVersion.join(' ')} --lockfile-only`;
            break;
          case 'yarn':
            installCmd = `yarn add ${pkgVersion.join(' ')} --ignore-scripts --prefer-offline`;
            break;
        }

        // 更新 package-lock.json
        runCmd(installCmd, currentProjectRoot);
        prettyOutput([
          `>> Write package.json and ${getPackageLockfile()} complete, please re-run install command.`
        ]);
      } else {
        prettyOutput([
          `>> Write complete, please re-run install command.`
        ]);
      }
    } else {
      prettyOutput([
        `>> Check complete, all versions are healthy.`
      ]);
    }
  } else {
    if (fail > 0) {
      prettyOutput([
        `>> Check complete, found \x1B[41m${fail}\x1B[0m package can be update.`,
        `>> Use \x1B[36m\x1B[1m${isCompatibleMode ? '-m -w' : '-u -w'}\x1B[0m to write to the package.json file and update the lock file if it exists.`,
        `>> Use \x1B[36m\x1B[1m--include-pkg-not-exists\x1B[0m include dependencies not exists.`,
        `>> Please check the result above.`
      ]);
    } else {
      prettyOutput([
        `>> Check complete, all versions are healthy.`,
        `>> Use \x1B[36m\x1B[1m--include-pkg-not-exists\x1B[0m include dependencies not exists.`,
      ]);
    }
  }

  return result;
}

function checkUpdate(coreVersion) {
  // save version to current dir
  const midwayVersionPkgVersion = getVersion('@midwayjs/version', false);
  // 是否是 pnpm 目录
  const isPnpm = existsSync(join(currentProjectRoot, 'node_modules/.pnpm'));
  // compare coreVersion and midwayVersionPkgVersion with semver version
  // 如果 coreVersion 大于 midwayVersionPkgVersion，则需要更新
  if (compareVersions(coreVersion, midwayVersionPkgVersion) > 0) {
    if (isNpxRun) {
      if (isPnpm) {
        // 使用 pnpx 执行当前命令
        prettyOutput([
          `>> Please use pnpx to run the command.`,
        ]);
      } else {
        prettyOutput([
          `>> Current version is too old, please run "npx clear-npx-cache" by yourself and re-run the command.`
        ]);
      }
    } else {
      prettyOutput([
        `>> Current version is too old, please upgrade dependencies and re-run the command.`
      ]);
    }

    return false;
  }
  return true;
}

exports.check = function (output = false, externalVersions = {}, options = {}) {
  outputConsole = output;
  const coreVersion = getVersion('@midwayjs/core');
  options.npmClient = options.npmClient || 'npm';

  if (!coreVersion) {
    outputError('>> Please install @midwayjs/core first');
    return;
  }

  if (!checkUpdate(coreVersion)) {
    return;
  }

  if (process.argv.includes('-u')) {
    // 更新到最新版本
    checkPackageUpdate(externalVersions, {
      coreVersion,
      ...options
    });
  } else if (process.argv.includes('-m')) {
    // 更新到当前可兼容的最新版本
    checkPackageUpdate(externalVersions, {
      mode: 'compatible',
      coreVersion,
      ...options
    });
  } else {
    return checkVersion(coreVersion, externalVersions, options);
  }
};

exports.getVersion = getVersion;
exports.checkPackageUpdate = checkPackageUpdate;
exports.checkVersion = checkVersion;
