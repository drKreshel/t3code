/**
 * `t3-code` MCP tools for boards and tickets (fork). Agents read and change
 * boards through these, never through `fork.sqlite`: writes go through
 * BoardsService, so open windows update live and the timeline records the chat.
 */
import {
  BoardColumnType,
  BoardKey,
  BoardsCommandError,
  TicketPriority,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
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
  description:
    "Column name (case-insensitive), or a column type: backlog, todo, active, review, attention, done, canceled.",
});

const ColumnSummary = Schema.Struct({
  name: Schema.String,
  type: BoardColumnType,
  tickets: Schema.Int,
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
  columnType: BoardColumnType,
  priority: TicketPriority,
  criteriaChecked: Schema.Int,
  criteriaTotal: Schema.Int,
  blockedBy: Schema.Array(Schema.String),
  attentionReason: Schema.NullOr(Schema.String),
  linkedChats: Schema.Int,
});
export type TicketSummary = typeof TicketSummary.Type;

export const TicketDetailResult = Schema.Struct({
  key: Schema.String,
  board: Schema.String,
  title: Schema.String,
  description: Schema.String,
  column: Schema.String,
  columnType: BoardColumnType,
  priority: TicketPriority,
  project: Schema.NullOr(Schema.String),
  attentionReason: Schema.NullOr(Schema.String),
  criteria: Schema.Array(
    Schema.Struct({ number: Schema.Int, text: Schema.String, checked: Schema.Boolean }),
  ),
  requires: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, done: Schema.Boolean }),
  ),
  blockedBy: Schema.Array(Schema.String),
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
    "List T3 Code boards with their keys, columns (name, type, ticket count), and default project. Boards plan work as tickets keyed like WEB-12.",
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
    "Read a ticket: description, acceptance criteria (numbered), requirements, comments, the latest handoff note, and linked chats. Without a key, reads the ticket this chat is linked to.",
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
    "Create a board. It starts with the columns Backlog, Todo, In progress, Testing, Needs you, and Done.",
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

const CreateTicketTool = Tool.make("create_ticket", {
  description:
    "Create a ticket on a board. Put checkable acceptance criteria in criteria, not in the description. Lands in the board's first backlog or todo column unless column is given.",
  parameters: Schema.Struct({
    board: TrimmedNonEmptyString.annotate({ description: "Board key like WEB." }),
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String.annotate({ description: "Markdown." })),
    column: Schema.optional(ColumnRef),
    priority: Schema.optional(TicketPriority),
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
    "Change a ticket's title, description, or priority, add or remove required tickets, and add, check, uncheck, or remove acceptance criteria. Criteria are named by number (from get_ticket), or exact text.",
  parameters: Schema.Struct({
    ticket: OptionalTicketRef,
    title: Schema.optional(TrimmedNonEmptyString),
    description: Schema.optional(Schema.String),
    priority: Schema.optional(TicketPriority),
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
    "Move a ticket to another column of its board. Refused while the ticket is blocked by unfinished required tickets and the move would start it. To ask the user for help, use request_human instead.",
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
    "Escalate a ticket to the user: moves it to its board's Needs you column with the reason. Use when you are stuck, need a decision, or need an answer only the user has. Not for ordinary review.",
  parameters: Schema.Struct({
    ticket: OptionalTicketRef,
    reason: TrimmedNonEmptyString.annotate({
      description: "One sentence on what you need from the user.",
    }),
  }),
  success: TicketChanged,
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Ask the user about a ticket")
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

export const BoardsToolkit = Toolkit.make(
  ListBoardsTool,
  ListTicketsTool,
  GetTicketTool,
  CreateBoardTool,
  CreateTicketTool,
  UpdateTicketTool,
  MoveTicketTool,
  AddCommentTool,
  RequestHumanTool,
  LinkThreadTool,
);
