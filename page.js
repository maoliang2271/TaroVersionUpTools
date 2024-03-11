const fs = require('fs');
const utils = require('./util');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse');
const generator = require('@babel/generator');
const t = require('@babel/types');
const typescript = require('typescript');
const { TaroUpdater, updaterQueue } = require('./core');

module.exports.transform = () => {
  const content = fs.readFileSync(utils.resolveSrc('app.config.ts'), {
    encoding: 'utf-8',
  });
  const ast = utils.createAST(content);
  utils.traverseAST(ast, (path) => {
    path.traverse({
      ExportDefaultDeclaration: (ExportDefaultDeclarationPath) => {
        const properties =
          ExportDefaultDeclarationPath.node.declaration.properties;
        let pages = [];
        properties.forEach((property) => {
          if (
            property.type === 'ObjectProperty' &&
            property.key.name === 'pages'
          ) {
            pages = pages.concat(
              pages,
              property.value.elements.map((i) => i.value),
            );
          }
          if (
            property.type === 'ObjectProperty' &&
            property.key.name === 'subPackages'
          ) {
            property.value.elements.forEach((item) => {
              const subProperties = item.properties;
              const subRoot = subProperties.find((i) => i.key.name === 'root');
              const subPages = subProperties.find(
                (i) => i.key.name === 'pages',
              );
              subPages.value.elements.forEach((i) => {
                pages.push(`${subRoot.value.value}/${i.value}`);
              });
            });
          }
        });

        pages.forEach((page) => {
          const file = utils.resolveSrc(page + '.tsx');
          const taroUpdater = new TaroUpdater(file, null);
          // taroUpdater.addTraverseTask({
          //   ExpressionStatement(ExpressionStatementPath) {
          //     if (!file.endsWith('.tsx')) {
          //       return;
          //     }
          //     const MemberExpressionPathNode =
          //       ExpressionStatementPath.node.expression.left;
          //     const valueNode = ExpressionStatementPath.node.expression.right;
          //     if (
          //       MemberExpressionPathNode?.property?.name === 'config' &&
          //       ExpressionStatementPath.parent.type === 'Program'
          //     ) {
          //       const config = t.exportDefaultDeclaration(valueNode);
          //       const result = generator.default(config, {
          //         retainLines: false,
          //         sourceMaps: false,
          //         decoratorsBeforeExport: true,
          //       });
          //       taroUpdater.logger.action('[将 config 迁移至 *.config.ts]');
          //       configFileName = file.replace('.tsx', '.config.ts');
          //       fs.writeFileSync(configFileName, result.code);
          //       ExpressionStatementPath.remove();
          //       return;
          //     }

          //     // 移除options
          //     if (
          //       MemberExpressionPathNode?.property?.name === 'options' &&
          //       ExpressionStatementPath.parent.type === 'Program'
          //     ) {
          //       taroUpdater.logger.action('[删除 options]');
          //       ExpressionStatementPath.remove();
          //       return;
          //     }
          //   },
          // });
          updaterQueue.addMacroTask(taroUpdater);
        });
      },
    });
  });
};
