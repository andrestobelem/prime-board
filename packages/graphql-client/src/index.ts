import { Kind, parse, print, visit, type ASTNode, type DocumentNode } from "graphql";

const WORKSPACE_FIELD = "workspaceId";

type SelectionSetNode = Extract<ASTNode, { kind: typeof Kind.SELECTION_SET }>;
type OperationNode = Extract<ASTNode, { kind: typeof Kind.OPERATION_DEFINITION }>;
type FragmentNode = Extract<ASTNode, { kind: typeof Kind.FRAGMENT_DEFINITION }>;
type FieldNode = Extract<ASTNode, { kind: typeof Kind.FIELD }>;

type WorkspaceFieldNode = FieldNode;

function workspaceFieldIsRemoved(node: WorkspaceFieldNode): boolean {
  return node.name.value === WORKSPACE_FIELD;
}

function withNonEmptySelectionSet<T extends SelectionSetNode>(node: T): T | null {
  return node.selections.length > 0 ? node : null;
}

function typenameSelection(): FieldNode {
  return {
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: "__typename" },
  };
}

function fallbackOperationSelection(node: OperationNode): OperationNode {
  if (node.operation === "subscription") {
    throw new Error("Legacy subscription has no compatible root fields");
  }
  return {
    ...node,
    selectionSet: {
      ...node.selectionSet,
      selections: [typenameSelection()],
    },
  };
}

function variablesInSelectionSet(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentNode>,
  visitedFragments: ReadonlySet<string> = new Set(),
): Set<string> {
  const variables = new Set<string>();
  visit(selectionSet, {
    Variable(node) {
      variables.add(node.name.value);
    },
  });

  const visitFragmentSpreads = (current: SelectionSetNode, visited: ReadonlySet<string>): void => {
    for (const selection of current.selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        if (visited.has(name)) continue;
        const fragment = fragments.get(name);
        if (!fragment) continue;
        const nextVisited = new Set(visited);
        nextVisited.add(name);
        for (const variable of variablesInSelectionSet(
          fragment.selectionSet,
          fragments,
          nextVisited,
        )) {
          variables.add(variable);
        }
        for (const directive of fragment.directives ?? []) {
          visit(directive, {
            Variable(variable) {
              variables.add(variable.name.value);
            },
          });
        }
        continue;
      }
      if (
        (selection.kind === Kind.FIELD || selection.kind === Kind.INLINE_FRAGMENT) &&
        selection.selectionSet
      ) {
        visitFragmentSpreads(selection.selectionSet, visited);
      }
    }
  };

  visitFragmentSpreads(selectionSet, visitedFragments);
  return variables;
}

function removeUnusedVariables(document: DocumentNode): DocumentNode {
  const fragments = new Map<string, FragmentNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  return visit(document, {
    OperationDefinition: {
      leave(node: OperationNode) {
        const usedVariables = variablesInSelectionSet(node.selectionSet, fragments);
        for (const directive of node.directives ?? []) {
          visit(directive, {
            Variable(variable) {
              usedVariables.add(variable.name.value);
            },
          });
        }
        const variableDefinitions = node.variableDefinitions?.filter((definition) =>
          usedVariables.has(definition.variable.name.value),
        );
        if (!variableDefinitions || variableDefinitions.length === node.variableDefinitions?.length)
          return node;
        return { ...node, variableDefinitions };
      },
    },
  });
}

function removeDanglingFragments(document: DocumentNode): DocumentNode {
  let current = document;
  while (true) {
    const availableFragments = new Set<string>();
    for (const definition of current.definitions) {
      if (
        definition.kind === Kind.FRAGMENT_DEFINITION &&
        definition.selectionSet.selections.length > 0
      ) {
        availableFragments.add(definition.name.value);
      }
    }

    let changed = false;
    const next = visit(current, {
      FragmentSpread: {
        leave(node) {
          if (availableFragments.has(node.name.value)) return node;
          changed = true;
          return null;
        },
      },
      FragmentDefinition: {
        leave(node: FragmentNode) {
          if (node.selectionSet.selections.length > 0) return node;
          changed = true;
          return null;
        },
      },
    });
    if (!changed) return next;
    current = next;
  }
}

function removeEmptySelectionNodes(document: DocumentNode): DocumentNode {
  return visit(document, {
    Field: {
      leave(node) {
        return node.selectionSet && !withNonEmptySelectionSet(node.selectionSet) ? null : node;
      },
    },
    InlineFragment: {
      leave(node) {
        return withNonEmptySelectionSet(node.selectionSet) ? node : null;
      },
    },
    FragmentDefinition: {
      leave(node: FragmentNode) {
        return withNonEmptySelectionSet(node.selectionSet) ? node : null;
      },
    },
    OperationDefinition: {
      leave(node: OperationNode) {
        if (node.selectionSet.selections.length > 0) return node;
        return fallbackOperationSelection(node);
      },
    },
  });
}

function removeUnusedFragments(document: DocumentNode): DocumentNode {
  const withoutDangling = removeDanglingFragments(document);
  const fragments = new Map<string, FragmentNode>();
  for (const definition of withoutDangling.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  const reachable = new Set<string>();
  const visitSelections = (selections: readonly ASTNode[], seen: Set<string>): void => {
    for (const selection of selections) {
      if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const name = selection.name.value;
        if (seen.has(name)) continue;
        reachable.add(name);
        const fragment = fragments.get(name);
        if (fragment) {
          const nextSeen = new Set(seen);
          nextSeen.add(name);
          visitSelections(fragment.selectionSet.selections, nextSeen);
        }
      } else if (selection.kind === Kind.FIELD || selection.kind === Kind.INLINE_FRAGMENT) {
        if (selection.selectionSet) visitSelections(selection.selectionSet.selections, seen);
      }
    }
  };

  for (const definition of withoutDangling.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      visitSelections(definition.selectionSet.selections, new Set());
    }
  }

  return visit(withoutDangling, {
    FragmentDefinition: {
      leave(node: FragmentNode) {
        return reachable.has(node.name.value) ? node : null;
      },
    },
    FragmentSpread: {
      leave(node) {
        return fragments.has(node.name.value) ? node : null;
      },
    },
  });
}

/**
 * Quita selecciones y argumentos exclusivos de Workspace de un documento GraphQL válido.
 *
 * La transformación AST conserva textos, nombres, aliases y directivas. También
 * quita variables y fragmentos sin uso, y conserva una operación válida de query o
 * mutation cuando la selección raíz solo contenía workspaceId. Las subscriptions sin
 * campos root compatibles se rechazan antes de enviarse.
 */
export function withoutWorkspaceFields(query: string): string {
  const document = parse(query);
  let transformed = visit(document, {
    Field: {
      leave(node) {
        if (workspaceFieldIsRemoved(node)) return null;
        const argumentsWithoutWorkspace = node.arguments?.filter(
          (argument) => argument.name.value !== WORKSPACE_FIELD,
        );
        if (node.selectionSet && !withNonEmptySelectionSet(node.selectionSet)) return null;
        if (
          argumentsWithoutWorkspace &&
          argumentsWithoutWorkspace.length !== node.arguments?.length
        )
          return { ...node, arguments: argumentsWithoutWorkspace };
        return node;
      },
    },
    InlineFragment: {
      leave(node) {
        return withNonEmptySelectionSet(node.selectionSet) ? node : null;
      },
    },
    FragmentDefinition: {
      leave(node) {
        return withNonEmptySelectionSet(node.selectionSet) ? node : null;
      },
    },
    OperationDefinition: {
      leave(node) {
        if (node.selectionSet.selections.length > 0) return node;
        return fallbackOperationSelection(node);
      },
    },
  });
  transformed = removeUnusedFragments(transformed);
  while (true) {
    const normalized = removeUnusedFragments(removeEmptySelectionNodes(transformed));
    if (print(normalized) === print(transformed)) {
      transformed = normalized;
      break;
    }
    transformed = normalized;
  }
  transformed = removeUnusedVariables(transformed);
  return print(transformed);
}
