import type { UserMessage } from "../types.js"

export type InboxTarget = "next-turn" | "next-step"

export class Inbox {
  private readonly nextTurn: UserMessage[] = []
  private readonly nextStep: UserMessage[] = []

  enqueue(target: InboxTarget, message: UserMessage): void {
    this.queueFor(target).push(message)
  }

  claim(target: InboxTarget): UserMessage[] {
    const messages = this.nextStep.splice(0)

    if (target === "next-turn") {
      const nextTurnMessage = this.nextTurn.shift()
      if (nextTurnMessage) messages.push(nextTurnMessage)
    }

    return messages
  }

  pending(target?: InboxTarget): number {
    if (target) return this.queueFor(target).length
    return this.nextTurn.length + this.nextStep.length
  }

  get hasPending(): boolean {
    return this.pending() > 0
  }

  private queueFor(target: InboxTarget): UserMessage[] {
    return target === "next-turn" ? this.nextTurn : this.nextStep
  }
}
