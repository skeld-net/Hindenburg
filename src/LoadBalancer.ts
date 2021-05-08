import dgram from "dgram";

import {
    HostGameMessage,
    JoinGameMessage,
    MessageDirection,
    RedirectMessage,
    ReliablePacket,
    Serializable
} from "@skeldjs/protocol";

import { DisconnectReason, SendOption } from "@skeldjs/constant";
import { HazelReader, sleep } from "@skeldjs/util";

import { HindenburgNode, HindenburgConfig } from "./Node";
import { Client } from "./Client";
import { formatSeconds } from "./util/format-seconds";

export class HindenburgLoadBalancer extends HindenburgNode {
    constructor(config: Partial<HindenburgConfig>) {
        super(config);

        this.redis.flushdb();

        this.decoder.on(HostGameMessage, async (message, direction, client) => {
            if (!this.checkMods(client))
                return;
            
            const random = this.config.master.nodes[~~(Math.random() * this.config.master.nodes.length)];

            const redirected = await this.redis.hgetall("redirected." + client.remote.address + "." + client.username);

            if (redirected) {
                const delete_at = new Date(redirected.date).getTime() + (parseInt(redirected.num) * 6000);
                if (Date.now() < delete_at) {
                    const ms = delete_at - Date.now();
                    this.logger.info(
                        "Client from %s still connecting to slave server, waiting %sms for client with ID %s to be redirected.",
                        client.remote.address, ms, client.clientid
                    );
                    await this.redis.hincrby("redirected." + client.remote.address + "." + client.username, "num", 1);
                    await sleep(ms);
                }
            }

            await this.redis.hmset("redirected." + client.remote.address + "." + client.username, {
                date: new Date().toString(),
                num: "1"
            });
            this.redis.expire("redirected." + client.remote.address + "." + client.username, 6);

            client.send(
                new ReliablePacket(
                    client.getNextNonce(),
                    [
                        new RedirectMessage(
                            random.ip,
                            random.port
                        )
                    ]
                )
            );

            this.logger.info(
                "Redirected client with ID %s to slave server %s:%s.",
                client.clientid, random.ip, random.port
            );
        });

        this.decoder.on(JoinGameMessage, (message, direction, client) => {
            if (!this.checkMods(client))
                return;
        });
    }

    get ip() {
        return this.config.master.ip;
    }

    listen() {
        return new Promise<void>(resolve => {
            this.socket.bind(this.config.master.port);
    
            this.socket.on("listening", () => {
                this.logger.info("Listening on *:%s", this.config.master.port);
                resolve();
            });
            
            this.socket.on("message", this.onMessage.bind(this));
        });
    }

    async handleInitial(parsed: Serializable, client: Client) {
        const banned = await this.redis.get("ban." + client.remote.address);
        if (banned) {
            const banned_time = new Date(banned).getTime();
            const seconds = (banned_time - Date.now()) / 1000;

            client.disconnect(
                DisconnectReason.Custom,
                this.config.anticheat.banMessage
                    .replace("%s", formatSeconds(~~seconds))
            );
            return;
        }

        const num_connections = await this.redis.get("connections." + client.remote.address);
        
        if (num_connections && this.config.anticheat.maxConnectionsPerIp > 0) {
            const connections = parseInt(num_connections);
            if (connections >= this.config.anticheat.maxConnectionsPerIp) {
                client.disconnect(
                    DisconnectReason.Custom,
                    "Too many connections coming from your IP."
                );
                return;
            }
        }

        try {
            this.decoder.emitDecoded(parsed, MessageDirection.Serverbound, client);
        } catch (e) {
            this.logger.error("%s", e.stack);
        }
    }
}