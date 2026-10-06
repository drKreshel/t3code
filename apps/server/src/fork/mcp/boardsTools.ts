/**
 * `t3-code` MCP tools for boards and tickets (fork). Agents read and change
 * boards through these, never through `fork.sqlite`: writes go through
 * BoardsService, so open windows update live and the timeline records the chat.
 */
import {
  BoardColumnColor,
  BoardKey,
  BoardsCommandError,
  PositiveInt,
  TicketPriority,
  TicketFolderPath,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  Orchestrator.OrchestratorV2,
  ProjectStore.ProjectStoreV2,
];

const failure = BoardsCommandError;

const TicketRef = TrimmedNonEmptyString.annotate({
  description: "Ticket key like WEB-12.",
});
const OptionalTicketRef = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description: "Ticket key like WEB-12. Defaults to the ticket this chat is linked to.",
  }),
);
const ColumnRef = TrimmedNonEmptyString.annotate({
  description: "Column name (case-insensitive), as list_boards shows it.",
});

const ColumnSummary = Schema.Struct({
  name: Schema.String,
  color: Schema.NullOr(Schema.String),
  tickets: Schema.Int,
  autoMove: Schema.NullOr(Schema.Struct({ afterDays: Schema.Int, to: Schema.String })).annotate({
    description: "Tickets left unchanged here this many days move on to the column `to`.",
  }),
});

const ColumnColor = Schema.NullOr(BoardColumnColor).annotate({
  description: "The column's dot color; null for the neutral one.",
});

const FlagSummary = Schema.NullOr(
  Schema.Struct({
    level: Schema.Literals(["warning", "error"]),
    reason: Schema.String,
  }),
).annotate({
  description:
    "Set when the ticket waits on the user: warning (help was asked for or work paused) or error (a run failed). Resume explicitly when ready.",
});

export const BoardSummary = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  defaultProject: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  columns: Schema.Array(ColumnSummary),
});
export type BoardSummary = typeof BoardSummary.Type;

export const TicketSummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  column: Schema.String,
  priority: TicketPriority,
  criteriaChecked: Schema.Int,
  criteriaTotal: Schema.Int,
  requires: Schema.Array(Schema.String).annotate({
    description: "Required tickets with the column each sits in, like 'API-1 (Done)'.",
  }),
  flag: FlagSummary,
  linkedChats: Schema.Int,
});
export type TicketSummary = typeof TicketSummary.Type;

export const TicketDetailResult = Schema.Struct({
  key: Schema.String,
  board: Schema.String,
  title: Schema.String,
  description: Schema.String,
  column: Schema.String,
  priority: TicketPriority,
  project: Schema.NullOr(Schema.String),
  folder: Schema.NullOr(Schema.String),
  history: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      actor: Schema.String,
      createdAt: Schema.String,
      payload: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  flag: FlagSummary,
  criteria: Schema.Array(
    Schema.Struct({ number: Schema.Int, text: Schema.String, checked: Schema.Boolean }),
  ),
  requires: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, column: Schema.String }),
  ).annotate({
    description:
      "Tickets this one depends on, with the column each sits in. Judge from those columns whether they are finished.",
  }),
  latestHandoff: Schema.NullOr(Schema.String),
  comments: Schema.Array(
    Schema.Struct({
      author: Schema.String,
      body: Schema.String,
      handoff: Schema.Boolean,
      createdAt: Schema.String,
    }),
  ),
  linkedChats: Schema.Array(Schema.Struct({ title: Schema.String, threadKey: Schema.String })),
  thisChatIsLinked: Schema.Boolean,
  workspace: Schema.NullOr(
    Schema.Struct({
      path: Schema.String.annotate({ description: "The ticket's folder; its chats run here." }),
      repos: Schema.Array(
        Schema.Struct({
          repo: Schema.String,
          checkout: Schema.Literals(["worktree", "local"]),
          path: Schema.String,
          branch: Schema.NullOr(Schema.String),
          startFrom: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ).annotate({
    description:
      "The ticket's workspace, if created: one worktree per repo on the ticket's branch (local repos are the shared main checkout).",
  }),
  path: Schema.String.annotate({
    description: "Where the ticket opens in T3 Code, like /boards/WEB/12.",
  }),
});
export type TicketDetailResult = typeof TicketDetailResult.Type;

const TicketChanged = Schema.Struct({
  key: Schema.String,
  column: Schema.String,
  path: Schema.String.annotate({
    description: "Where the ticket opens in T3 Code, like /boards/WEB/12.",
  }),
});

const ListBoardsTool = Tool.make("list_boards", {
  description:
    "List T3 Code boards with their keys, columns (name and ticket count), and default project. Boards plan work as tickets keyed like WEB-12.",
  parameters: Schema.Struct({
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ boards: Schema.Array(BoardSummary) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List boards")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListTicketsTool = Tool.make("list_tickets", {
  description:
    "List tickets, optionally filtered by board key, column, and text in the title or description.",
  parameters: Schema.Struct({
    board: Schema.optional(TrimmedNonEmptyString.annotate({ description: "Board key like WEB." })),
    column: Schema.optional(ColumnRef),
    query: Schema.optional(TrimmedNonEmptyString),
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ tickets: Schema.Array(TicketSummary) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "List tickets")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const GetTicketTool = Tool.make("get_ticket", {
  description:
    "Read a ticket: description, folder, acceptance criteria (numbered), requirements, comments, the latest handoff note, and linked chats. Without a key, reads the ticket this chat is linked to.",
  parameters: Schema.Struct({ ticket: OptionalTicketRef }),
  success: TicketDetailResult,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Get ticket")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CreateBoardTool = Tool.make("create_board", {
  description:
    "Create a board. Without a template or columns it starts with the columns Backlog, Todo, In progress, Review, and Done.",
  parameters: Schema.Struct({
    name: TrimmedNonEmptyString,
    key: BoardKey.annotate({
      description: "2 to 5 capital letters or digits, starting with a letter, like WEB.",
    }),
    useThisChatsProject: Schema.optional(
      Schema.Boolean.annotate({
        description: "Make this chat's project the board's default project for new chats.",
      }),
    ),
    template: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          'A board template\'s name, like "Ship with agents": the board gets its columns. Only when the user asks for one.',
      }),
    ),
    columns: Schema.optional(
      Schema.Array(
        Schema.Struct({ name: TrimmedNonEmptyString, color: Schema.optional(ColumnColor) }),
      ).annotate({ description: "The board's columns, first to last. Not with template." }),
    ),
  }),
  success: BoardSummary,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create board")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateBoardTool = Tool.make("update_board", {
  description:
    "Change a board: its name, key, default project, or archived state, and add, rename, recolor, remove, or reorder its columns. Every reference is checked before anything changes. Columns record progress only; editing them never starts an agent.",
  parameters: Schema.Struct({
    board: TrimmedNonEmptyString.annotate({ description: "Board key like WEB." }),
    name: Schema.optional(TrimmedNonEmptyString),
    key: Schema.optional(
      BoardKey.annotate({ description: "A new key. Ticket keys change with it, like WEB-12." }),
    ),
    useThisChatsProject: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "true: make this chat's project the board's default project. false: clear the default project.",
      }),
    ),
    archived: Schema.optional(Schema.Boolean),
    updateColumns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          column: ColumnRef,
          name: Schema.optional(TrimmedNonEmptyString),
          color: Schema.optional(ColumnColor),
          autoMove: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                afterDays: PositiveInt,
                to: TrimmedNonEmptyString.annotate({
                  description: "The column they move to, named as after this call.",
                }),
              }),
            ).annotate({
              description:
                "Move tickets left unchanged in this column for afterDays on to another column, like Done to Settled after 7 days. null stops it.",
            }),
          ),
        }),
      ).annotate({ description: "Rename, recolor, or set ticket moves on existing columns." }),
    ),
    addColumns: Schema.optional(
      Schema.Array(
        Schema.Struct({ name: TrimmedNonEmptyString, color: Schema.optional(ColumnColor) }),
      ).annotate({ description: "New columns; they go last unless columnOrder places them." }),
    ),
    removeColumns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          column: ColumnRef,
          moveTicketsTo: Schema.optional(
            TrimmedNonEmptyString.annotate({
              description:
                "Where the column's tickets go, named as after this call. Required when it has tickets.",
            }),
          ),
        }),
      ),
    ),
    columnOrder: Schema.optional(
      Schema.Array(TrimmedNonEmptyString).annotate({
        description:
          "Every column, first to last, named as after this call's renames, additions, and removals.",
      }),
    ),
  }),
  success: BoardSummary,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Update board")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CreateTicketTool = Tool.make("create_ticket", {
  description:
    "Create a ticket on a board. Put checkable acceptance criteria in criteria, not in the description. Lands in the board's first backlog or todo column unless column is given.",
  parameters: Schema.Struct({
    board: TrimmedNonEmptyString.annotate({ description: "Board key like WEB." }),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String.annotate({ description: "Markdown." })),
    column: Schema.optional(ColumnRef),
    priority: Schema.optional(TicketPriority),
    folder: Schema.optional(
      Schema.NullOr(TicketFolderPath).annotate({
        description:
          'Sidebar folder path for this ticket\'s chats, e.g. "SalonesDeFiestas/salones-infantiles". Missing folders are created in each client.',
      }),
    ),
    criteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    requires: Schema.optional(
      Schema.Array(TicketRef).annotate({
        description: "Keys of tickets that must be done before this one can start.",
      }),
    ),
    useThisChatsProject: Schema.optional(
      Schema.Boolean.annotate({
        description: "Set this chat's project as the ticket's project.",
      }),
    ),
    linkThisChat: Schema.optional(
      Schema.Boolean.annotate({ description: "Link this chat to the new ticket." }),
    ),
  }),
  success: TicketChanged,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Create ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const UpdateTicketTool = Tool.make("update_ticket", {
  description:
    "Change a ticket's title, description, priority, or folder, add or remove required tickets, and add, check, uncheck, or remove acceptance criteria. Criteria are named by number (from get_ticket), or exact text.",
  parameters: Schema.Struct({
    ticket: OptionalTicketRef,
    title: Schema.optional(TrimmedNonEmptyString),
    description: Schema.optional(Schema.String),
    priority: Schema.optional(TicketPriority),
    folder: Schema.optional(
      Schema.NullOr(TicketFolderPath).annotate({
        description:
          "Sidebar folder path for linked chats. Use / for nested folders, or null to stop automatic filing.",
      }),
    ),
    addCriteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    checkCriteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    uncheckCriteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    removeCriteria: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    addRequires: Schema.optional(Schema.Array(TicketRef)),
    removeRequires: Schema.optional(Schema.Array(TicketRef)),
  }),
  success: TicketChanged,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Update ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const MoveTicketTool = Tool.make("move_ticket", {
  description:
    "Move a ticket to another column to record progress. Moving it never starts an agent or resolves its flag. To ask the user for help, use request_human.",
  parameters: Schema.Struct({
    ticket: OptionalTicketRef,
    column: ColumnRef,
  }),
  success: TicketChanged,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Move ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const AddCommentTool = Tool.make("add_comment", {
  description:
    "Comment on a ticket. Set handoff=true for the note the next chat on this ticket should start from: what was done, what failed, what is left.",
  parameters: Schema.Struct({
    ticket: OptionalTicketRef,
    body: TrimmedNonEmptyString.annotate({ description: "Markdown." }),
    handoff: Schema.optional(Schema.Boolean),
  }),
  success: TicketChanged,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Comment on ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const RequestHumanTool = Tool.make("request_human", {
  description:
    "Mark this chat Needs you when you are blocked without the user. The user may be away and read this later with no context, so write `reason` as short markdown: what you were doing, what happened, and the decision or action needed. When there are concrete ways forward, offer them as options; the user can always answer in their own words, and their answer continues this session. For ordinary questions while the user is present, use the provider's question tool. Leave a ticket handoff when linked, then stop.",
  parameters: Schema.Struct({
    reason: TrimmedNonEmptyString.annotate({
      description:
        "Markdown summary: what you were doing, what blocks progress, and what the user needs to decide or do. Use short paragraphs or bullets.",
    }),
    options: Schema.optional(
      Schema.Array(
        Schema.Struct({
          label: TrimmedNonEmptyString.annotate({ description: "Short choice, 1-5 words." }),
          description: TrimmedNonEmptyString.annotate({
            description: "What you will do if the user picks this.",
          }),
        }),
      ).annotate({
        description:
          "2-4 ways forward the user can pick. Picking one sends it to you immediately, so each must be a complete decision.",
      }),
    ),
  }),
  success: Schema.Struct({ threadId: Schema.String, path: Schema.String }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Request help in this chat")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const LinkThreadTool = Tool.make("link_thread_to_ticket", {
  description:
    "Link this chat to a ticket so it shows under the ticket's sessions and ticket tools default to it. A chat links to one ticket; linking again moves it. Pass no ticket to unlink.",
  parameters: Schema.Struct({
    ticket: Schema.optional(TicketRef),
  }),
  success: Schema.Struct({ linkedTo: Schema.NullOr(Schema.String) }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Link chat to ticket")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RemoveWorkspaceTool = Tool.make("remove_ticket_workspace", {
  description:
    "Remove the ticket's workspace: its worktrees go, their branches stay, and the next chat on the ticket recreates them. Refused while a worktree has uncommitted changes or unpushed commits unless force is set. Use when the work is merged or pushed and the ticket is closing.",
  parameters: Schema.Struct({
    ticket: OptionalTicketRef,
    force: Schema.optional(
      Schema.Boolean.annotate({ description: "Remove even with unsaved work. Only when told to." }),
    ),
  }),
  success: Schema.Struct({ removed: Schema.Boolean }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Remove ticket workspace")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BoardsToolkit = Toolkit.make(
  ListBoardsTool,
  ListTicketsTool,
  GetTicketTool,
  CreateBoardTool,
  UpdateBoardTool,
  CreateTicketTool,
  UpdateTicketTool,
  MoveTicketTool,
  AddCommentTool,
  RequestHumanTool,
  LinkThreadTool,
  RemoveWorkspaceTool,
);
