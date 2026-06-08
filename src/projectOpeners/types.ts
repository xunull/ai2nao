export type ProjectOpenerId = "vscode" | "cursor" | "warp" | "iterm2";

export type ProjectOpenerKind = "editor" | "terminal";

export type ProjectOpener = {
  id: ProjectOpenerId;
  label: string;
  kind: ProjectOpenerKind;
};

export type OpenProjectRequest = {
  opener: ProjectOpenerId;
  path: string;
};

export type OpenProjectResult = {
  ok: true;
  opener: ProjectOpenerId;
  path: string;
};
