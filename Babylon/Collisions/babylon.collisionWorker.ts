module BABYLON.CollisionWorker {

    export class CollisionCache {
        private _meshes: { [n: number]: SerializedMesh; } = {};
        private _geometries: { [s: number]: SerializedGeometry; } = {};

        public getMeshes(): { [n: number]: SerializedMesh; } {
            return this._meshes;
        }

        public getGeometries(): { [s: number]: SerializedGeometry; } {
            return this._geometries;
        }

        public getMesh(id: any): SerializedMesh {
            return this._meshes[id];
        }

        public addMesh(mesh: SerializedMesh) {
            this._meshes[mesh.uniqueId] = mesh;
        }

        public getGeometry(id: string): SerializedGeometry {
            return this._geometries[id];
        }

        public addGeometry(geometry: SerializedGeometry) {
            this._geometries[geometry.id] = geometry;
        }
    }

    export class CollideWorker {

        private collisionsScalingMatrix = BABYLON.Matrix.Zero();
        private collisionTranformationMatrix = BABYLON.Matrix.Zero();

        constructor(public collider: BABYLON.Collider, private _collisionCache: CollisionCache, private finalPosition: BABYLON.Vector3) {

        }

        public collideWithWorld(position: BABYLON.Vector3, velocity: BABYLON.Vector3, maximumRetry: number, excludedMeshUniqueId?: number) {

            var closeDistance = BABYLON.Engine.CollisionsEpsilon * 10.0;
            //is initializing here correct? A quick look - looks like it is fine.
            
            if (this.collider.retry >= maximumRetry) {
                this.finalPosition.copyFrom(position);
                return;
            }

            this.collider._initialize(position, velocity, closeDistance);
        

            // Check all meshes
            var meshes = this._collisionCache.getMeshes();
            for (var uniqueId in meshes) {
                if (meshes.hasOwnProperty(uniqueId) && parseInt(uniqueId) != excludedMeshUniqueId) {
                    var mesh: SerializedMesh = meshes[uniqueId];
                    if (mesh.checkCollisions)
                        this.checkCollision(mesh);
                }
            }

            if (!this.collider.collisionFound) {
                position.addToRef(velocity, this.finalPosition);
                return;
            }

            if (velocity.x !== 0 || velocity.y !== 0 || velocity.z !== 0) {
                this.collider._getResponse(position, velocity);
            }

            if (velocity.length() <= closeDistance) {
                //console.log("webworker collision with " + this.collider.collidedMesh);
                this.finalPosition.copyFrom(position);
                return;
            }

            this.collider.retry++;
            this.collideWithWorld(position, velocity, maximumRetry, excludedMeshUniqueId);
        }

        private checkCollision(mesh: SerializedMesh) {

            if (!this.collider._canDoCollision(BABYLON.Vector3.FromArray(mesh.sphereCenter), mesh.sphereRadius, BABYLON.Vector3.FromArray(mesh.boxMinimum), BABYLON.Vector3.FromArray(mesh.boxMaximum))) {
                return;
            };

            // Transformation matrix
            BABYLON.Matrix.ScalingToRef(1.0 / this.collider.radius.x, 1.0 / this.collider.radius.y, 1.0 / this.collider.radius.z, this.collisionsScalingMatrix);
            var worldFromCache = BABYLON.Matrix.FromArray(mesh.worldMatrixFromCache);
            worldFromCache.multiplyToRef(this.collisionsScalingMatrix, this.collisionTranformationMatrix);

            this.processCollisionsForSubMeshes(this.collisionTranformationMatrix, mesh);
            //return colTransMat;
        }

        private processCollisionsForSubMeshes(transformMatrix: BABYLON.Matrix, mesh: SerializedMesh): void {
            var len: number;

            // No Octrees for now
            //if (this._submeshesOctree && this.useOctreeForCollisions) {
            //    var radius = collider.velocityWorldLength + Math.max(collider.radius.x, collider.radius.y, collider.radius.z);
            //    var intersections = this._submeshesOctree.intersects(collider.basePointWorld, radius);

            //    len = intersections.length;
            //    subMeshes = intersections.data;
            //} else {
            //    subMeshes = this.subMeshes;
            //    len = subMeshes.length;
            //}

            if (!mesh.geometryId) {
                console.log("no mesh geometry id");
                return;
            }

            var meshGeometry = this._collisionCache.getGeometry(mesh.geometryId);
            if (!meshGeometry) {
                console.log("couldn't find geometry", mesh.geometryId);
                return;
            }

            for (var index = 0; index < mesh.subMeshes.length; index++) {
                var subMesh = mesh.subMeshes[index];

                // Bounding test
                if (len > 1 && !this.checkSubmeshCollision(subMesh))
                    continue;

                subMesh['getMesh'] = function () {
                    return mesh.uniqueId;
                }
                this.collideForSubMesh(subMesh, transformMatrix, meshGeometry);
            }
        }

        private collideForSubMesh(subMesh: SerializedSubMesh, transformMatrix: BABYLON.Matrix, meshGeometry: SerializedGeometry): void {
            var positionsArray = [];
            for (var i = 0; i < meshGeometry.positions.length; i = i + 3) {
                var p = BABYLON.Vector3.FromArray([meshGeometry.positions[i], meshGeometry.positions[i + 1], meshGeometry.positions[i + 2]]);
                positionsArray.push(p);
            }
            subMesh['_lastColliderTransformMatrix'] = transformMatrix.clone();
            subMesh['_lastColliderWorldVertices'] = [];
            subMesh['_trianglePlanes'] = [];
            var start = subMesh.verticesStart;
            var end = (subMesh.verticesStart + subMesh.verticesCount);
            for (var i = start; i < end; i++) {
                subMesh['_lastColliderWorldVertices'].push(BABYLON.Vector3.TransformCoordinates(positionsArray[i], transformMatrix));
            }
        
            //}
            // Collide
            this.collider._collide([], subMesh['_lastColliderWorldVertices'], <any> meshGeometry.indices, subMesh.indexStart, subMesh.indexStart + subMesh.indexCount, subMesh.verticesStart, subMesh.hasMaterial);
        }

        //TODO - this! :-)
        private checkSubmeshCollision(subMesh: SerializedSubMesh) {
            return true;
        }


    }

    export interface ICollisionDetector {
        onInit(payload: InitPayload): void;
        onUpdate(payload: UpdatePayload): void;
        onCollision(payload: CollidePayload): void;
    }

    export class CollisionDetectorTransferable implements ICollisionDetector {
        private _collisionCache: CollisionCache;

        public onInit(payload: InitPayload) {
            this._collisionCache = new CollisionCache();
            var reply: WorkerReply = {
                error: WorkerReplyType.SUCCESS,
                taskType: WorkerTaskType.INIT
            }
            postMessage(reply, undefined);
        }

        public onUpdate(payload: UpdatePayload) {
            for (var id in payload.updatedGeometries) {
                if (payload.updatedGeometries.hasOwnProperty(id)) {
                    this._collisionCache.addGeometry(payload.updatedGeometries[id]);
                }
            }
            for (var uniqueId in payload.updatedMeshes) {
                if (payload.updatedMeshes.hasOwnProperty(uniqueId)) {
                    this._collisionCache.addMesh(payload.updatedMeshes[uniqueId]);
                }
            }

            var replay: WorkerReply = {
                error: WorkerReplyType.SUCCESS,
                taskType: WorkerTaskType.UPDATE
            }
            console.log("updated");
            postMessage(replay, undefined);
        }

        public onCollision(payload: CollidePayload) {
            var finalPosition = BABYLON.Vector3.Zero();
            //create a new collider
            var collider = new BABYLON.Collider();
            collider.radius = BABYLON.Vector3.FromArray(payload.collider.radius);

            var colliderWorker = new CollideWorker(collider, this._collisionCache, finalPosition);
            colliderWorker.collideWithWorld(BABYLON.Vector3.FromArray(payload.collider.position), BABYLON.Vector3.FromArray(payload.collider.velocity), payload.maximumRetry, payload.excludedMeshUniqueId);
            var replyPayload: CollisionReplyPayload = {
                collidedMeshUniqueId: <any> collider.collidedMesh,
                collisionId: payload.collisionId,
                newPosition: finalPosition.asArray()
            }
            var reply: WorkerReply = {
                error: WorkerReplyType.SUCCESS,
                taskType: WorkerTaskType.COLLIDE,
                payload: replyPayload
            }
            postMessage(reply, undefined);
        }
    }

    //check if we are in a web worker, as this code should NOT run on the main UI thread
    if (self && !self.document) {

        var collisionDetector: ICollisionDetector = new CollisionDetectorTransferable();

        var onNewMessage = function (event: MessageEvent) {
            var message = <BabylonMessage> event.data;
            switch (message.taskType) {
                case WorkerTaskType.INIT:
                    collisionDetector.onInit(<InitPayload> message.payload);
                    break;
                case WorkerTaskType.COLLIDE:
                    collisionDetector.onCollision(<CollidePayload> message.payload);
                    break;
                case WorkerTaskType.UPDATE:
                    collisionDetector.onUpdate(<UpdatePayload> message.payload);
                    break;
            }
        }

        self.onmessage = onNewMessage;
    }

}