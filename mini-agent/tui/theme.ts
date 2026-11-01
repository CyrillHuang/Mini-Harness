export type TuiTheme = {
  assistant: (text: string) => string
  tool: (text: string) => string
  result: (text: string) => string
  error: (text: string) => string
  warning: (text: string) => string
  muted: (text: string) => string
  selected: (text: string) => string
}

/** 创建终端颜色主题；关闭颜色时返回原文本。 */
export function createTuiTheme(color: boolean): TuiTheme {
  const paint = (code: number, text: string) =>
    color
      ? String.fromCharCode(27) + "[" + code + "m" + text + String.fromCharCode(27) + "[39m"
      : text
  return {
    assistant: (text) => paint(36, text),
    tool: (text) => paint(35, text),
    result: (text) => paint(90, text),
    error: (text) => paint(31, text),
    warning: (text) => paint(33, text),
    muted: (text) => paint(90, text),
    selected: (text) => color
      ? String.fromCharCode(27) + "[47m" + text + String.fromCharCode(27) + "[0m"
      : text,
  }
}
