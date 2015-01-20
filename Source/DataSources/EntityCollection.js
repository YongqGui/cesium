/*global define*/
define([
        '../Core/AssociativeArray',
        '../Core/createGuid',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/DeveloperError',
        '../Core/Event',
        '../Core/Iso8601',
        '../Core/JulianDate',
        '../Core/RuntimeError',
        '../Core/TimeInterval',
        './Entity'
    ], function(
        AssociativeArray,
        createGuid,
        defined,
        defineProperties,
        DeveloperError,
        Event,
        Iso8601,
        JulianDate,
        RuntimeError,
        TimeInterval,
        Entity) {
    "use strict";

    var entityOptionsScratch = {
        id : undefined
    };

    function fireChangedEvent(collection) {
        if (collection._suspendCount === 0) {
            var added = collection._addedEntities;
            var removed = collection._removedEntities;
            var changed = collection._changedEntities;
            if (changed.length !== 0 || added.length !== 0 || removed.length !== 0) {
                collection._collectionChanged.raiseEvent(collection, added.values, removed.values, changed.values);
                added.removeAll();
                removed.removeAll();
                changed.removeAll();
            }
        }
    }

    /**
     * An observable collection of {@link Entity} instances where each entity has a unique id.
     * @alias EntityCollection
     * @constructor
     */
    var EntityCollection = function() {
        this._entities = new AssociativeArray();
        this._addedEntities = new AssociativeArray();
        this._removedEntities = new AssociativeArray();
        this._changedEntities = new AssociativeArray();
        this._suspendCount = 0;
        this._collectionChanged = new Event();
        this._id = createGuid();
    };

    /**
     * Prevents {@link EntityCollection#collectionChanged} events from being raised
     * until a corresponding call is made to {@link EntityCollection#resumeEvents}, at which
     * point a single event will be raised that covers all suspended operations.
     * This allows for many items to be added and removed efficiently.
     * This function can be safely called multiple times as long as there
     * are corresponding calls to {@link EntityCollection#resumeEvents}.
     */
    EntityCollection.prototype.suspendEvents = function() {
        this._suspendCount++;
    };

    /**
     * Resumes raising {@link EntityCollection#collectionChanged} events immediately
     * when an item is added or removed.  Any modifications made while while events were suspended
     * will be triggered as a single event when this function is called.
     * This function is reference counted and can safely be called multiple times as long as there
     * are corresponding calls to {@link EntityCollection#resumeEvents}.
     *
     * @exception {DeveloperError} resumeEvents can not be called before suspendEvents.
     */
    EntityCollection.prototype.resumeEvents = function() {
        //>>includeStart('debug', pragmas.debug);
        if (this._suspendCount === 0) {
            throw new DeveloperError('resumeEvents can not be called before suspendEvents.');
        }
        //>>includeEnd('debug');

        this._suspendCount--;
        fireChangedEvent(this);
    };

    /**
     * The signature of the event generated by {@link EntityCollection#collectionChanged}.
     * @function
     *
     * @param {EntityCollection} collection The collection that triggered the event.
     * @param {Entity[]} added The array of {@link Entity} instances that have been added to the collection.
     * @param {Entity[]} removed The array of {@link Entity} instances that have been removed from the collection.
     * @param {Entity[]} changed The array of {@link Entity} instances that have been modified.
     */
    EntityCollection.collectionChangedEventCallback = undefined;

    defineProperties(EntityCollection.prototype, {
        /**
         * Gets the event that is fired when entities are added or removed from the collection.
         * The generated event is a {@link EntityCollection.collectionChangedEventCallback}.
         * @memberof EntityCollection.prototype
         * @readonly
         * @type {Event}
         */
        collectionChanged : {
            get : function() {
                return this._collectionChanged;
            }
        },
        /**
         * Gets a globally unique identifier for this collection.
         * @memberof EntityCollection.prototype
         * @readonly
         * @type {String}
         */
        id : {
            get : function() {
                return this._id;
            }
        },
        /**
         * Gets the array of Entity instances in the collection.
         * This array should not be modified directly.
         * @memberof EntityCollection.prototype
         * @readonly
         * @type {Entity[]}
         */
        entities : {
            get : function() {
                return this._entities.values;
            }
        }
    });

    /**
     * Computes the maximum availability of the entities in the collection.
     * If the collection contains a mix of infinitely available data and non-infinite data,
     * it will return the interval pertaining to the non-infinite data only.  If all
     * data is infinite, an infinite interval will be returned.
     *
     * @returns {TimeInterval} The availability of entities in the collection.
     */
    EntityCollection.prototype.computeAvailability = function() {
        var startTime = Iso8601.MAXIMUM_VALUE;
        var stopTime = Iso8601.MINIMUM_VALUE;
        var entities = this._entities.values;
        for (var i = 0, len = entities.length; i < len; i++) {
            var entity = entities[i];
            var availability = entity.availability;
            if (defined(availability)) {
                var start = availability.start;
                var stop = availability.stop;
                if (JulianDate.lessThan(start, startTime) && !start.equals(Iso8601.MINIMUM_VALUE)) {
                    startTime = start;
                }
                if (JulianDate.greaterThan(stop, stopTime) && !stop.equals(Iso8601.MAXIMUM_VALUE)) {
                    stopTime = stop;
                }
            }
        }

        if (Iso8601.MAXIMUM_VALUE.equals(startTime)) {
            startTime = Iso8601.MINIMUM_VALUE;
        }
        if (Iso8601.MINIMUM_VALUE.equals(stopTime)) {
            stopTime = Iso8601.MAXIMUM_VALUE;
        }
        return new TimeInterval({
            start : startTime,
            stop : stopTime
        });
    };

    /**
     * Add an entity to the collection.
     *
     * @param {Entity} entity The entity to be added.
     * @exception {DeveloperError} An entity with <entity.id> already exists in this collection.
     */
    EntityCollection.prototype.add = function(entity) {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(entity)) {
            throw new DeveloperError('entity is required.');
        }
        //>>includeEnd('debug');

        if (!(entity instanceof Entity)) {
            entity = new Entity(entity);
        }

        var id = entity.id;
        var entities = this._entities;
        if (entities.contains(id)) {
            throw new RuntimeError('An entity with id ' + id + ' already exists in this collection.');
        }

        entities.set(id, entity);

        var removedEntities = this._removedEntities;
        if (!this._removedEntities.remove(id)) {
            this._addedEntities.set(id, entity);
        }
        entity.definitionChanged.addEventListener(EntityCollection.prototype._onEntityDefinitionChanged, this);

        fireChangedEvent(this);
        return entity;
    };

    /**
     * Removes an entity from the collection.
     *
     * @param {Entity} entity The entity to be added.
     * @returns {Boolean} true if the item was removed, false if it did not exist in the collection.
     */
    EntityCollection.prototype.remove = function(entity) {
        if (!defined(entity)) {
            return false;
        }
        return this.removeById(entity.id);
    };

    /**
     * Removes an entity with the provided id from the collection.
     *
     * @param {Object} id The id of the entity to remove.
     * @returns {Boolean} true if the item was removed, false if no item with the provided id existed in the collection.
     */
    EntityCollection.prototype.removeById = function(id) {
        if (!defined(id)) {
            return false;
        }

        var entities = this._entities;
        var entity = entities.get(id);
        if (!this._entities.remove(id)) {
            return false;
        }

        if (!this._addedEntities.remove(id)) {
            this._removedEntities.set(id, entity);
            this._changedEntities.remove(id);
        }
        this._entities.remove(id);
        entity.definitionChanged.removeEventListener(EntityCollection.prototype._onEntityDefinitionChanged, this);
        fireChangedEvent(this);

        return true;
    };

    /**
     * Removes all Entities from the collection.
     */
    EntityCollection.prototype.removeAll = function() {
        //The event should only contain items added before events were suspended
        //and the contents of the collection.
        var entities = this._entities;
        var entitiesLength = entities.length;
        var array = entities.values;

        var addedEntities = this._addedEntities;
        var removed = this._removedEntities;

        for (var i = 0; i < entitiesLength; i++) {
            var existingItem = array[i];
            var existingItemId = existingItem.id;
            var addedItem = addedEntities.get(existingItemId);
            if (!defined(addedItem)) {
                existingItem.definitionChanged.removeEventListener(EntityCollection.prototype._onEntityDefinitionChanged, this);
                removed.set(existingItemId, existingItem);
            }
        }

        entities.removeAll();
        addedEntities.removeAll();
        this._changedEntities.removeAll();
        fireChangedEvent(this);
    };

    /**
     * Gets an entity with the specified id.
     *
     * @param {Object} id The id of the entity to retrieve.
     * @returns {Entity} The entity with the provided id or undefined if the id did not exist in the collection.
     */
    EntityCollection.prototype.getById = function(id) {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(id)) {
            throw new DeveloperError('id is required.');
        }
        //>>includeEnd('debug');

        return this._entities.get(id);
    };


    /**
     * Gets an entity with the specified id or creates it and adds it to the collection if it does not exist.
     *
     * @param {Object} id The id of the entity to retrieve or create.
     * @returns {Entity} The new or existing object.
     */
    EntityCollection.prototype.getOrCreateEntity = function(id) {
        //>>includeStart('debug', pragmas.debug);
        if (!defined(id)) {
            throw new DeveloperError('id is required.');
        }
        //>>includeEnd('debug');

        var entity = this._entities.get(id);
        if (!defined(entity)) {
            entityOptionsScratch.id = id;
            entity = new Entity(entityOptionsScratch);
            this.add(entity);
        }
        return entity;
    };

    EntityCollection.prototype._onEntityDefinitionChanged = function(entity) {
        var id = entity.id;
        if (!this._addedEntities.contains(id)) {
            this._changedEntities.set(id, entity);
        }
        fireChangedEvent(this);
    };

    return EntityCollection;
});
