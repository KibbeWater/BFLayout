/**
 * BYML documents: Nintendo's binary tree format, used for configuration data.
 *
 * Read-only. Parsing covers versions 1-7 in both byte orders; there is no writer,
 * so nothing here can save a BYML file back.
 */

export type { BymlDocument, BymlMapEntry, BymlNode } from './types'
export {
  BymlNodeType,
  countNodes,
  isContainer,
  isOffsetNode,
  nodeTypeName,
  nodeTypeOf,
  walkByml
} from './types'

export { isByml, parseByml } from './codec'

export type { BymlDocumentView, BymlNodeView } from './view'
export {
  formatScalar,
  isViewContainer,
  toBymlView,
  viewChildCount
} from './view'
