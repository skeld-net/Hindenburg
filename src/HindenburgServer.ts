import {
    BaseRootMessage,
    DataMessage,
    DespawnMessage,
    GameDataToMessage,
    GameOptions,
    HelloPacket,
    HostGameMessage,
    JoinGameMessage,
    MessageDirection,
    ReliablePacket,
    RpcMessage,
    SpawnMessage
} from "@skeldjs/protocol";

import {
    DisconnectReason,
    GameMap,
    GameState
} from "@skeldjs/constant";

import { Code2Int } from "@skeldjs/util";
import { SpawnPrefabs } from "@skeldjs/core";

import { Room } from "./Room";
import { HindenburgConfig, HindenburgNode } from "./Node";
import { Client, ClientEvents } from "./Client";

export class HindenburgServer extends HindenburgNode<ClientEvents> {
    rooms: Map<number, Room>;

    constructor(config: Partial<HindenburgConfig>) {
        super(config);

        this.rooms = new Map;

        this.decoder.on(HelloPacket, async (message, direction, client) => {
            const was_redirected = await this.redis.hget("redirected." + client.remote.address + "." + client.username, "num");
            
            if (!was_redirected) {
                client.disconnect(
                    DisconnectReason.Custom,
                    "Please connect through the master server."
                );
                return;
            }

            if (was_redirected === "1") {
                await this.redis.del("redirected." + client.remote.address + "." + client.username);
            } else {
                await this.redis.hincrby("redirected." + client.remote.address + "." + client.username, "num", -1);
            }
        });

        this.decoder.on(HostGameMessage, (message, direction, client) => {
            if (!this.checkMods(client))
                return;

            if (this.config.anticheat.checkSettings && !GameOptions.isValid(message.options)) {
                this.logger.warn("Client with ID %s created game with invalid settings.", client.clientid);

                if (client.penalize("checkSettings")) {
                    return;
                }
            }
            
            const chars = [];
            for (let i = 0; i < 6; i++) {
                chars.push(~~(Math.random() * 26) + 65);
            }
            const name = String.fromCharCode(...chars);
            const code = Code2Int(name);

            const room = new Room(this);
            room.settings.patch(message.options);
            room.setCode(code);
            this.rooms.set(code, room);

            this.redis.set("room." + name, this.ip + ":" + this.ip)

            this.logger.info(
                "Client with ID %s created game %s on %s with %s impostors and %s max players.",
                client.clientid, name,
                GameMap[message.options.map], message.options.numImpostors, message.options.maxPlayers
            );

            client.send(
                new ReliablePacket(
                    client.getNextNonce(),
                    [
                        new HostGameMessage(code)
                    ]
                )
            );
        });

        this.decoder.on(JoinGameMessage, (message, direction, client) => {
            if (!this.checkMods(client))
                return;
            
            const room = this.rooms.get(message.code);

            if (!room)
                return client.joinError(DisconnectReason.GameNotFound);

            if (room.clients.size >= room.settings.maxPlayers)
                client.joinError(DisconnectReason.GameFull);

            if (room.state === GameState.Started)
                client.joinError(DisconnectReason.GameStarted);

            room.handleRemoteJoin(client);
        });

        this.decoder.on([ DataMessage, RpcMessage, DespawnMessage ], (message, direction, client) => {
            if (!client.room)
                return;

            const player = client.room.players.get(client.clientid);

            if (!player)
                return;

            const component = client.room.netobjects.get(message.netid);

            if (!component)
                return;
                
            if (
                component.ownerid !== client.clientid
                && !(component.ownerid === -2 && player.ishost)
            ) {
                if (client.penalize("checkObjectOwnership")) {
                    return;
                }
            }

            client.room.decoder.emitDecoded(message, direction, client);
        });

        this.decoder.on(SpawnMessage, (message, direction, client) => {
            if (!client.room)
                return;

            const player = client.room.players.get(client.clientid);

            if (!player)
                return;

            if (!player.ishost) {
                if (client.penalize("hostChecks")) {
                    return;
                }
            }

            const prefab = SpawnPrefabs[message.spawnType];
            if (prefab) {
                if (prefab.length !== message.components.length) {
                    client.penalize("malformedPackets")
                    return;
                }
            }

            client.room.decoder.emitDecoded(message, direction, client);
        });

        this.decoder.on(GameDataToMessage, (message, direction, client) => {
            if (!client.room)
                return;

            const player = client.room.players.get(client.clientid);
            const recipient = client.room.players.get(message.recipientid);

            if (!recipient || !player)
                return;

            if (!recipient?.ishost) {
                return;
            }
        });

        this.on("client.disconnect", async disconnect => {
            const connections = await this.redis.get("connections." + disconnect.client.remote.address);

            if (connections === "1") {
                this.redis.del("connections." + disconnect.client.remote.address);
            } else {
                this.redis.decr("connections." + disconnect.client.remote.address);
            }
            
            const infraction_keys = await this.redis.keys("infractions." + this.ip + "." + disconnect.client.clientid + ".*");

            this.redis.del(infraction_keys);
        });
    }

    get ip() {
        return this.config.node.ip;
    }

    listen() {
        return new Promise<void>(resolve => {
            this.socket.bind(this.config.node.port);
    
            this.socket.on("listening", () => {
                this.logger.info("Listening on *:%s", this.config.node.port);
                resolve();
            });
    
            this.socket.on("message", this.onMessage.bind(this));
        });
    }

    async graceful() {
        this.logger.info(
            "Performing graceful shutdown on %s room(s) and %s client(s)..",
            this.rooms.size, this.clients.size
        );

        for (const [ , room ] of this.rooms) {
            await room.destroy();
        }

        for (const [ , client ] of this.clients) {
            await client.disconnect(DisconnectReason.Custom, "Server is shutting down.");
        }

        this.socket.close();

        this.logger.info(
            "Gracefully shutdown server, goodbye."
        );
    }

    async handleInitial(parsed: BaseRootMessage, client: Client) {
        const num_connections = await this.redis.incr("connections." + client.remote.address);

        if (num_connections && this.config.anticheat.maxConnectionsPerIp > 0) {
            if (num_connections > this.config.anticheat.maxConnectionsPerIp) {
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