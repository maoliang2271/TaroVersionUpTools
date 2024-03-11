const fs = require('fs');
const path = require('path');
const t = require('@babel/types');
const { default: template } = require('@babel/template');

const toJSON = (data) => {
  return JSON.stringify(data, null, 2);
};

/**
 * path resolve 项目目录
 */
const resolve = (...paths) => path.resolve(process.cwd(), ...paths);

/**
 * path resolve 项目 src 目录
 */
const resolveSrc = (...paths) => resolve('src', ...paths);

/**
 * 遍历目录
 * @param {*} dir
 * @param {*} callback
 */
const traverseDir = (dir, callback) => {
  const paths = fs.readdirSync(dir);
  paths.forEach((currentPath) => {
    const fullPath = dir.endsWith('/')
      ? dir + currentPath
      : dir + '/' + currentPath;
    if (fs.lstatSync(fullPath).isDirectory()) {
      traverseDir(fullPath, callback);
    } else {
      callback(fullPath);
    }
  });
};

const defaultLogPath = path.resolve(process.cwd(), 'update');

class Logger {
  static totalTSFileNum = 0;
  static totalSCSSFileNum = 0;
  static updateTSFileNum = 0;
  static updateSCSSFileNum = 0;

  static updateTime = 0;
  static updatePages = [];
  static updateFiles = [];
  static record = {};

  static addRecord(type, fileName, content, code) {
    Logger.record[type] = Logger.record[type] || [];
    Logger.record[type].push({ fileName, content, code });
  }

  static writeLogger() {
    try {
      require('ejs').renderFile(
        resolve('scripts/up/output/output.html'),
        {
          totalTSFileNum: Logger.totalTSFileNum,
          totalSCSSFileNum: Logger.totalSCSSFileNum,
          updateTSFileNum: Logger.updateTSFileNum,
          updateSCSSFileNum: Logger.updateSCSSFileNum,
          updateTime: Logger.updateTime,
          unChangedFile: Logger.unChangedFile,
          updateFiles: Logger.updateFiles.map((i) =>
            i.replace(resolveSrc(), ''),
          ),
          updatePages: Logger.updatePages.map((i) =>
            i.replace(resolveSrc(), ''),
          ),
          warn: Logger.record.warn || [],
          CURRENT_AND_GLOBAL_NOT_MATCH:
            Logger.record.CURRENT_AND_GLOBAL_NOT_MATCH || [],
          CURRENT_NOT_MATCH_BUT_GLOBAL_MATCH:
            Logger.record.CURRENT_NOT_MATCH_BUT_GLOBAL_MATCH || [],
        },
        {},
        function (err, str) {
          console.log(err, str);
          fs.writeFileSync(defaultLogPath + '.html', str, {
            encoding: 'utf-8',
          });
        },
      );
      fs.writeFileSync(
        defaultLogPath + '.json',
        JSON.stringify(Logger.record, null, 2),
        { encoding: 'utf-8' },
      );
    } catch (err) {
      console.log(err);
    }
  }

  constructor(fileName) {
    this.fileName = fileName.replace(resolveSrc(), '');
  }

  log(...content) {
    Logger.addRecord('log', this.fileName, content);
  }

  warn(name, code, ...content) {
    this.log(...content);
    const text = content.join(' ');
    // if (Logger.record.warn && Logger.record.warn.find((i) => i.code === code)) {
    //   const match = Logger.record.warn.find((i) => i.code === code);
    //   match.children = match.children || [];
    //   match.children.push({ fileName: this.fileName, code, content: text });
    // } else {
    //   Logger.record.warn = Logger.record.warn || [];
    //   Logger.record.warn.push({
    //     code,
    //     children: [{ fileName: this.fileName, code, content: text }],
    //   });
    // }
    if (Logger.record.warn && Logger.record.warn.find((i) => i.fileName === this.fileName)) {
      const match = Logger.record.warn.find((i) => i.fileName === this.fileName);
      match.children = match.children || [];
      if (match.children.find(item => item.code === code && item.content === text)) {
        return;
      } else {
        match.children.push({ code, content: text });
      }
    } else {
      Logger.record.warn = Logger.record.warn || [];
      Logger.record.warn.push({
        fileName: this.fileName,
        children: [{ code, content: text }],
      });
    }
  }

  group(type, code, content, source) {
    // if (
    //   Logger.record[type] &&
    //   Logger.record[type].find((i) => i.code === code)
    // ) {
    //   const match = Logger.record[type].find((i) => i.code === code);
    //   match.children = match.children || [];
    //   match.children.push({
    //     fileName: this.fileName,
    //     code,
    //     content,
    //     source,
    //   });
    // } else {
    //   Logger.record[type] = Logger.record[type] || [];
    //   Logger.record[type].push({
    //     code,
    //     children: [{ fileName: this.fileName, code, content, source }],
    //   });
    // }

    if (
        Logger.record[type] &&
        Logger.record[type].find((i) => i.fileName === this.fileName)
      ) {
        const match = Logger.record[type].find((i) => i.fileName === this.fileName);
        match.children = match.children || [];

        if (match.children.find(item => item.code === code && item.content === content && item.code === code && item.source === source)) {
          return;
        } else {
          match.children.push({
            code,
            content,
            source,
          });
        }
      } else {
        Logger.record[type] = Logger.record[type] || [];
        Logger.record[type].push({
          fileName: this.fileName,
          children: [{ code, content, source }],
        });
      }
  }

  action(...content) {
    Logger.updateTime++;
    this.log(...content);
  }
}

const createAST = (content) => {
  return require('@babel/parser').parse(content, {
    sourceType: 'module',
    plugins: [
      'typescript',
      'jsx',
      [('decorators', { decoratorsBeforeExport: true })],
      'classProperties',
      'classPrivateProperties',
    ],
  });
};

const traverseAST = (ast, callback) => {
  require('@babel/traverse').default(ast, {
    enter(path) {
      callback(path);
    },
  });
};

const createTemplate = (temp) => {
  const fn = template(temp, {
    syntacticPlaceholders: false,
    placeholderPattern: false,
    sourceType: 'module',
    plugins: [
      'typescript',
      'jsx',
      [('decorators', { decoratorsBeforeExport: true })],
      'classProperties',
      'classPrivateProperties',
    ],
  });
  return fn();
};

/**
 * 处理router
 */
const createRouterHandler = (updater) => {
  let scopeName = null;
  return {
    // 处理this.$router
    MemberExpression(MemberExpressionPath) {
      const { node } = MemberExpressionPath;
      const { object, property } = node;
      if (object.type === 'ThisExpression' && property.name === '$router') {
        node.object = t.callExpression(t.identifier('getCurrentInstance'), []);
        property.name = 'router';
        updater.injectTaro('getCurrentInstance');
        updater.logger.action(
          `this.$router 修改为 getCurrentInstance().router`,
        );
        return;
      }

      if (object.type === 'ThisExpression' && property.name === '$scope') {
        node.object = t.callExpression(t.identifier('getCurrentInstance'), []);
        MemberExpressionPath.node.property.name = 'page';
        updater.injectTaro('getCurrentInstance');
        updater.logger.action(`this.$scope 修改为 getCurrentInstance().page`);
      }

      // scope.xxxx() => getCurrentInstance().page.xxx();
      if (object.name === scopeName) {
        node.object = t.optionalMemberExpression(
          t.callExpression(t.identifier('getCurrentInstance'), []),
          t.identifier('page'),
          false,
          true,
        );
        updater.injectTaro('getCurrentInstance');
        updater.logger.action(
          `对象${scopeName}.? 修改为 getCurrentInstance().page.?`,
        );
      }
    },

    Identifier(IdentifierPath) {
      if (IdentifierPath.node.name === scopeName) {
        IdentifierPath.replaceWith(
          t.optionalMemberExpression(
            t.callExpression(t.identifier('getCurrentInstance'), []),
            t.identifier('page'),
            false,
            true,
          ),
        );
        updater.injectTaro('getCurrentInstance');
        updater.logger.action(
          `变量 ${scopeName} 修改为 getCurrentInstance().page`,
        );
      }
    },

    // const scope = useScope();
    VariableDeclarator(VariableDeclaratorPath) {
      VariableDeclaratorPath.traverse({
        ArrowFunctionExpression(ArrowFunctionExpressionPath) {
          const { params, body } = ArrowFunctionExpressionPath.node;
          if (
            params?.length === 1 &&
            params[0].name === 'dispatch' &&
            body?.name === 'dispatch'
          ) {
            updater.logger.action('[修复redux dispatch错误]');
            VariableDeclaratorPath.node.init = t.identifier('undefined');
          }
        },
      });
      if (
        VariableDeclaratorPath.node.init?.type === 'CallExpression' &&
        VariableDeclaratorPath.node.init.callee.name === 'useScope'
      ) {
        scopeName = VariableDeclaratorPath.node.id.name;
        VariableDeclaratorPath.remove();
        updater.logger.action(`删除 useScope hook`);
      }
    },
  };
};

const copyDirectory = (src, dest) => {
  if (IsFileExist(dest) == false) {
    fs.mkdirSync(dest);
  }
  if (fs.existsSync(src) == false) {
    return false;
  }
  // console.log("src:" + src + ", dest:" + dest);
  // 拷贝新的内容进去
  var dirs = fs.readdirSync(src);
  dirs.forEach(function (item) {
    var item_path = path.join(src, item);
    var temp = fs.statSync(item_path);
    if (temp.isFile()) {
      // 是文件
      // console.log("Item Is File:" + item);
      fs.copyFileSync(item_path, path.join(dest, item));
    } else if (temp.isDirectory()) {
      // 是目录
      // console.log("Item Is Directory:" + item);
      copyDirectory(item_path, path.join(dest, item));
    }
  });
};

module.exports = {
  resolve,
  resolveSrc,
  traverseDir,
  createAST,
  traverseAST,
  createRouterHandler,
  createTemplate,
  copyDirectory,
  Logger,
};
