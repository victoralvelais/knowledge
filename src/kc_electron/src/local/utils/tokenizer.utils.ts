/*
 * Copyright (c) 2023-2024 Rob Royce
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

import {
  encoding_for_model,
  init,
  Tiktoken,
  TiktokenModel,
} from "@dqbd/tiktoken/init";
import fs from "fs";
import path from "path";
import { app } from "electron";
import {
  ChatModel,
  SupportedChatModels,
} from "../../../../kc_shared/models/chat.model";
import { Completions } from "openai/resources/chat";
import CreateChatCompletionRequestMessage = Completions.CreateChatCompletionRequestMessage;

import settingsService from "../../app/services/settings.service";

export default class TokenizerUtils {
  private tiktoken!: Tiktoken;

  private model: TiktokenModel = "gpt-4o";

  constructor() {
    this.initialize();
  }

  async initialize() {
    const tiktokenWasm = this.getWasmPath();
    const wasm = fs.readFileSync(tiktokenWasm);
    await init((imports) => WebAssembly.instantiate(wasm, imports));
    console.debug(`[Knowledge]: Initializing ${this.model} tokenizer...`);
    this.tiktoken = encoding_for_model(this.model);
  }

  async setModel(model: TiktokenModel) {
    if (this.model === model) {
      return;
    }

    try {
      console.debug(`[Knowledge]: Freeing ${this.model} tokenizer...`);
      this.tiktoken?.free();
    } catch (err) {
      console.error(
        `[Knowledge]: Trying to free ${this.model} tokenizer...`,
        err
      );
    }

    this.model = model;

    try {
      await this.initialize();
    } catch (e) {
      console.error("Error setting model to: ", model);
      console.error(e);
    }
  }

  /**
   * Given a token limit, prune the messages to fit within the limit.
   * Fails if the last message is longer than the limit.
   * Removes non-system messages first, then removes system messages if necessary.
   */
  limitTokens(
    messages: CreateChatCompletionRequestMessage[],
    max_tokens: number
  ) {
    if (messages.length === 0) {
      return messages;
    }

    // If the messages are already within the token limit, return them.
    let tokenCount = this.countMessageTokens(messages);
    if (tokenCount < max_tokens) {
      return messages;
    }

    // Split messages into two, the first N messages and the last message
    const lastMessage = messages.pop();
    if (!lastMessage) {
      throw new Error("No message found.");
    }
    if (this.countMessageTokens([lastMessage]) > max_tokens) {
      throw new Error("Message is longer than the token limit.");
    }

    /* While the token count is greater than the limit, remove messages.
    Remove the first non-system message while the token count is greater than the limit.
    If no non-system messages are found, remove the first system message. */
    while (tokenCount > max_tokens) {
      const firstNonSystemMessage = messages.find(
        (message) => message.role !== "system"
      );
      if (
        firstNonSystemMessage &&
        firstNonSystemMessage.content !== lastMessage.content
      ) {
        const removed = messages.splice(
          messages.indexOf(firstNonSystemMessage),
          1
        );
        tokenCount -= this.countMessageTokens(removed);
      } else {
        const removed = messages.shift();
        if (!removed) {
          throw new Error("No message found.");
        }
        tokenCount -= this.countMessageTokens([removed]);
      }
    }
    messages.push(lastMessage);
    return messages;
  }

  deduplicate(messages: CreateChatCompletionRequestMessage[]) {
    // Remove duplicate messages using a hash map based on message content.
    const unique: CreateChatCompletionRequestMessage[] = [];
    const hash: { [key: string]: boolean } = {};
    messages.forEach((message) => {
      if (message.content && !hash[message.content]) {
        hash[message.content] = true;
        unique.push(message);
      }
    });

    return unique;
  }

  countTokens(text: string) {
    return this.tiktoken.encode(text).length + 5;
  }

  countMessageTokens(messages: CreateChatCompletionRequestMessage[]): number {
    let tokenCount = 0;
    messages.forEach((message: CreateChatCompletionRequestMessage) => {
      if (message.content) {
        tokenCount += this.tiktoken.encode(message.content).length + 5;
      }
    });
    return tokenCount + (messages.length > 1 ? 3 : 0);
  }

  chunkLimitText(text: string): string[] {
    /**
     * Given a text, chunk it into pieces that are within the token limit.
     */
    const model = this.verifiedModel();
    const maxTokens = model.token_limit - model.max_tokens - 512;

    const tokenized = this.tiktoken.encode(text);
    if (tokenized.length <= maxTokens) {
      return [text];
    }

    const chunks = [];

    // Split the tokenized array into arrays of maxTokens length
    for (let i = 0; i < tokenized.length; i += maxTokens) {
      chunks.push(tokenized.slice(i, i + maxTokens));
    }

    // Convert each chunk back into a string
    const chunkedText: string[] = [];
    chunks.forEach((chunk) => {
      let text = "";
      chunk.forEach((unit8) => {
        text += String.fromCharCode.apply(null, [unit8]);
      });
      chunkedText.push(text);
    });

    return chunkedText;
  }

  limitText(text: string): string {
    const model = this.verifiedModel();
    // TODO: this 512 should be equal to the number of tokens taken by the rest of the messages
    let maxTokens = model.token_limit - model.max_tokens - 512;

    maxTokens = Math.max(maxTokens, 0);

    let tokenized = this.tiktoken.encode(text);
    if (tokenized.length > maxTokens) {
      console.warn(
        `[Knowledge]: Tokenized length (${tokenized.length}) greater than max tokens (${maxTokens}), truncating.`
      );
      tokenized = tokenized.slice(0, maxTokens);
      const decoded = this.tiktoken.decode(tokenized);

      // Decoded is an array of Unit8Array, we need to convert that back into a string
      text = "";
      decoded.forEach((unit8) => {
        text += String.fromCharCode.apply(null, [unit8]);
      });
    }

    return text;
  }

  private getWasmPath() {
    // TODO: Figure out how to do this in a cleaner way
    const possiblePaths = [
      path.resolve(app.getAppPath(), "..", "tiktoken_bg.wasm"),
      path.join(
        settingsService.getSettings().system.resourcesPath,
        "tiktoken_bg.wasm"
      ),
      path.join(process.cwd(), "Resources", "tiktoken_bg.wasm"),
      path.join(process.cwd(), "resources", "tiktoken_bg.wasm"),
      path.join(__dirname, "Resources", "tiktoken_bg.wasm"),
      path.join(__dirname, "resources", "tiktoken_bg.wasm"),
      path.join("tiktoken_bg.wasm"),
      path.join(process.cwd(), "tiktoken_bg.wasm"),
    ];

    for (const possible of possiblePaths) {
      if (fs.existsSync(possible)) {
        return possible;
      }
    }
    throw new Error("Could not find tiktoken wasm file.");
  }

  private verifiedModel(): ChatModel {
    const model = SupportedChatModels.find(
      (model) => model.name === this.model
    );
    if (!model) {
      throw new Error(
        `Model ${this.model} not found. You may need to check your settings and restart the app.`
      );
    } else {
      return model;
    }
  }
}
