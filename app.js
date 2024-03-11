const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse');
const generator = require('@babel/generator');
const t = require('@babel/types');
const { resolveSrc, copyDirectory } = require('./util');
const { TaroUpdater, ShadowContainer } = require('./core');


module.exports.transform = () => {
  const taroUpdater = new TaroUpdater(resolveSrc('app.tsx'), null);
  taroUpdater.addTraverseTask({
    ClassProperty(ClassPropertyPath) {
      if (ClassPropertyPath.node.key.name === 'config') {
        taroUpdater.logger.action("将config 从 app.tsx 转移到 app.config.ts")
        const appConfigNode = t.exportDefaultDeclaration(
          ClassPropertyPath.node.value,
        );

        // taroUpdater.logger.action("app.config.ts 添加 shadow 组件")
        // const obj = appConfigNode.declaration.properties.find(item => item.key.value === 'usingComponents');
        // if (obj) {
        //   obj.value.properties.push(
        //     t.objectProperty(
        //       t.stringLiteral(ShadowContainer),
        //       t.stringLiteral('./components/ShadowContainer')
        //     )
        //   )
        // } else {
        //   appConfigNode.declaration.properties.push(
        //     t.objectProperty(
        //       t.stringLiteral('usingComponents'),
        //       t.objectExpression(
        //         t.objectProperty(
        //           t.stringLiteral(ShadowContainer),
        //           t.stringLiteral('./components/ShadowContainer')
        //         )
        //       )
        //     )
        //   )
        // }

        // 文件拷贝
        // taroUpdater.logger.action("components 生成 shadow 组件")
        // copyDirectory(path.resolve(__dirname, 'ShadowContainer'), resolveSrc('components/ShadowContainer'))

        const result = generator.default(appConfigNode, {
          retainLines: false,
          sourceMaps: false,
          decoratorsBeforeExport: true,
        });
        fs.writeFileSync(resolveSrc('app.config.ts'), result.code);
        ClassPropertyPath.remove();
      }
    },
    ExpressionStatement(ExpressionStatementPath) {
      ExpressionStatementPath.traverse({
        CallExpression(CallExpressionPath) {
          CallExpressionPath.traverse({
            MemberExpression(MemberExpressionPath) {
              if (
                MemberExpressionPath.node.object.name === 'Taro' &&
                MemberExpressionPath.node.property.name === 'render'
              ) {
                taroUpdater.logger.action(`删除 Taro.render`)
                ExpressionStatementPath.remove();
              }
            },
          });
        },
      });
    },
    ClassDeclaration(ClassDeclarationPath) {
      if (ClassDeclarationPath.parent.type === 'Program') {
        let isExitExportDefaultDeclaration = false;
        let ExportDefaultDeclarationMatch =
          ClassDeclarationPath.parent.body.find(
            (i) => i.type === 'ExportDefaultDeclaration',
          );
        if (ExportDefaultDeclarationMatch) {
          if (
            ExportDefaultDeclarationMatch.declaration.name !==
            ClassDeclarationPath.node.id.name
          ) {
            throw new Error('app.ts 已存在 默认导出且不为app');
          }
        } else {
          taroUpdater.logger.action(`添加 app.ts 默认导出 为类组件`)
          ClassDeclarationPath.insertAfter(
            t.exportDefaultDeclaration(
              t.identifier(ClassDeclarationPath.node.id.name),
            ),
          );
        }
        return;
      }
    },
    ClassMethod(ClassMethodPath) {
      if (ClassMethodPath.node.key.name === 'componentWillMount') {
        taroUpdater.logger.action(`componentWillMount 替换 为 componentDidMount`)
        ClassMethodPath.node.key.name = 'componentDidMount';
      }
    },
  });
  taroUpdater.transform();
};

module.exports.transform;
