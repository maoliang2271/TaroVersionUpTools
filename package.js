const fs = require('fs');
const path = require('path');
const utils = require('./util');
const child_process = require('child_process');

const latest = [3, 5, 12];

const coreDepend = [
  '@tarojs/plugin-platform-weapp',
  '@tarojs/plugin-framework-react',
  '@tarojs/mini-runner',
  '@tarojs/webpack5-runner',
  '@tarojs/react',
  '@tarojs/cli',
  'babel-preset-taro',
];

const newDepend = {
  'react-dom': '18.2.0',
  'react-redux': '8.0.5',
  'redux': '4.2.1',
  'lodash': '4.17.21',
  'dayjs': '1.11.5',
  'webpack': '5.75.0',
  '@swc/wasm': '1.3.2',
  'postcss-js': '4.0.0',
  'sass': '1.55.0',
  '@babel/generator': '7.20.5',
  'ejs': '3.1.8',
};

const expire = [
  '@tarojs/async-await',
  '@tarojs/plugin-babel',
  '@tarojs/plugin-csso',
  '@tarojs/plugin-sass',
  '@tarojs/plugin-uglifyjs',
  '@tarojs/taro-tt',
  '@tarojs/redux-h5',
  '@tarojs/taro-swan',
  '@tarojs/taro-alipay',
  '@tarojs/redux',
  '@tarojs/taro-weapp',
  'nervjs',
  'nerv-devtools',
];

const updateDepend = {
  'typescript': '4.9.5',
  'react': '18.2.0',
  '@types/react': '18.2.0',
  'taro-ui': '3.1.0-beta.4',
  '@tencent/musician-common': '^1.2.78-alpha.81.0'
};

const logger = new utils.Logger(utils.resolve('package.json'));

const updateVersion = (obj, matcher, target) => {
  Object.keys(obj).map((key) => {
    if (key.match(matcher)) {
      const versionStr = obj[key];
      let version = versionStr
        .replace(/[\^\~]/, '')
        .split('.')
        .map((i) => +i);
      if (version[0] < target[0] || version[1] < target[1] || version[2] < target[2]) {
        version = target;
      }
      logger.action('[更新依赖]', key, versionStr, version.join('.'));
      obj[key] = version.join('.');
    }
  });
};

const transform = () => {
  const file = fs.readFileSync(utils.resolve('package.json'), {
    encoding: 'utf-8',
  });
  const content = JSON.parse(file);
  const { devDependencies, dependencies } = content;
  updateVersion(devDependencies, /^@tarojs/gi, latest);
  updateVersion(dependencies, /^@tarojs/gi, latest);

  coreDepend.forEach((i) => {
    if (!dependencies[i] && !devDependencies[i]) {
      logger.action('[添加依赖]', i, latest.join('.'));
      dependencies[i] = latest.join('.');
    }
  });

  Object.keys(newDepend).forEach((i) => {
    if (!dependencies[i] && !devDependencies[i]) {
      logger.action('[添加依赖]', i, newDepend[i]);
      dependencies[i] = newDepend[i];
    }
  });

  expire.forEach((i) => {
    if (dependencies[i]) {
      logger.action('[删除依赖]', i, dependencies[i]);
      delete dependencies[i];
    }
    if (devDependencies[i]) {
      logger.action('[删除依赖]', i, devDependencies[i]);
      delete devDependencies[i];
    }
  });

  Object.keys(updateDepend).forEach((i) => {
    if (dependencies[i]) {
      logger.action('[更新依赖]', i, dependencies[i], updateDepend[i]);
      dependencies[i] = updateDepend[i];
    }
    if (devDependencies[i]) {
      logger.action('[更新依赖]', i, devDependencies[i], updateDepend[i]);
      devDependencies[i] = updateDepend[i];
    }
  });

  fs.writeFileSync(
    utils.resolve('package.json'),
    JSON.stringify(content, null, 4),
  );
};

const doInstall = () => {
  console.log('开始更新依赖文件');
  transform();
  console.log('开始执行 npm install');
  child_process.exec('npm install', (err, stdout, stderr) => {
    console.log(stdout)
    if (err) {
      console.log('npm install 失败', err);
      return;
    }
    console.log('npm install 成功');
  });
};

doInstall();
