import { UESaveObject } from './lib/UE4Reader.js';
import { browser } from './utils.js';
import { EventSystem } from './eventSystem.js';
import { Settings } from './settings.js';
import { MapObject } from './mapObject.jsx';
import { UE5SaveDecoder } from './UE5SaveDecoder.js';

// Tracks a set of listeners for specific Id's from the save data (one listener per id)
// Id's are either area:name or property name
// For array properties listeners can provide a filter for the array property name
// Properties are assumed to default to false if no other default is provided
// Handles saving of property states to Settings for any properties with listeners

export class SaveFileSystem {
  static _saveListeners = new EventSystem();
  static _decodeHandlers = new EventSystem({
    onAddListener: (handlerId, listener) => SaveFileSystem.onAddDecodeHandler(handlerId, listener),
    onRemoveListener: (handlerId, listener) => SaveFileSystem.onRemoveDecodeHandler(handlerId, listener),
  });
  static _outerHandlerIds = [];

  //-----------------------------------------------------------------------------------------------
  // Save event listeners are called whenever the save data associated with the id
  // is changed (set, loaded or cleared). The id is typically instance {area}:{name}
  // but can be any key string.

  // Return true if there is a listener for the specified id
  static hasListener(id) {
    return this._saveListeners.hasListener(id);
  }

  // Add function to be called when the save data change event is fired fired. Overwrites
  // any previous listener.
  //
  // id: string: identifies instance this listener (usually instance id '{area}:{name}')
  // fn: function(ctx: any, id: string, data: varies): called when save data for instance changes
  // context: object: used as this pointer for callbacks
  // defaultValue: any: data specific to listener instance class [false]
  static setListener(id, { fn, self = null, context = null, defaultValue = false } = {}) {
    this._saveListeners.addListener(id, { fn, self, context, defaultValue });
  }

  // Remove function/context to be removed as listener to specified event
  static clearListener(id, { fn, self = null, context = null }) {
    this._saveListeners.removeListener(id, { fn, self, context });
  }

  // Call all functions listening for event
  static callListener(id, data) {
    return this._saveListeners.fire(id, data);
  }

  //-----------------------------------------------------------------------------------------------
  // Decode handlers are called when the save data is read from the file, the default only handles
  // instances, if they are present in the file then the listener is called with 'true'.
  //
  // To customise behaviour for non-instance strings or specific properties within instance data
  // a decoderHandler is called to provide the opportunity to transform what is done.
  //
  // Id is normally a game class, but can be any string.

  // Returns true if there is a decodeHandler associated with this id
  static hasDecodeHandler(handlerId) {
    return this._decodeHandlers.hasListener(handlerId);
  }

  // Set the decodeHandler for a specific instance type or key string
  static setDecodeHandler(handlerId, { fn, self = null, isOuterHandler = false } = {}) {
    this._decodeHandlers.removeListener(handlerId);
    this._decodeHandlers.addListener(handlerId, { fn, self, context: { isOuterHandler } });
  }

  static onAddDecodeHandler(handlerId, listener) {
    if (listener.context.isOuterHandler) {
      this._outerHandlerIds.push(handlerId);
    }
  }

  // Clear the corresponding decode handler
  static clearDecodeHandler(handlerId, { fn, self = null } = {}) {
    this._decodeHandlers.removeListener(handlerId, { fn, self });
  }

  static onRemoveDecodeHandler(handlerId) {
    const idx = this._outerHandlerIds.indexOf(handlerId);
    if (idx > -1) {
      this._outerHandlerIds.splice(idx, 1);
    }
  }

  // If there's a decoder then call it (used for global properties in save
  // file such as LastCheckpointActor)
  static callDecoderHandler(saveDecoder) {
    return this._decodeHandlers.fire(saveDecoder.handlerId, saveDecoder);
  }

  // If there is a listener for this object then add it as found (data)
  static defaultDecodeHandler(saveDecoder, data) {
    Settings.map.saveData[saveDecoder.listenerId] = data || saveDecoder.data;
  }

  //-----------------------------------------------------------------------------------------------
  // Clear all listeners and handlers (without calling)
  static reset() {
    this._saveListeners.reset();
    this._decodeHandlers.reset();
    this._outerHandlerIds = [];
  }

  //-----------------------------------------------------------------------------------------------
  // The current state of the save data loaded is stored in Settings so that
  // it persists between sessions.

  // Returns true if there is any save data at the moment
  static hasAnyData() {
    for (const id in Settings.map.saveData) {
      return true;
    }
    return false;
  }

  // Retrieve current value of id
  static getData(id) {
    let data = Settings.map.saveData[id];
    if (data !== undefined) {
      return data;
    }
    const defaultValue = this._saveListeners.getDefaultData(id);
    return defaultValue !== undefined ? defaultValue : false;
  }

  // Called to set property to a specific value (commits Settings so inefficient for multiple calls)
  static setData(id, data) {
    if (this._saveListeners.listenerCount > 0) {
      const defaultValue = this._saveListeners.getDefaultData(id) ?? false;
      if (data === defaultValue) {
        delete Settings.map.saveData[id];
      } else {
        Settings.map.saveData[id] = data;
      }
      Settings.commit();

      this._saveListeners.fire(id, data);
    }
  }

  // Should be called after all listeners are established. Listeners are presumed to be
  // in default state already.
  static LoadSettings() {
    Settings.mapSetDefault('saveData', {});

    for (const id of this._saveListeners.getEventIds()) {
      this._saveListeners.fire(id, this.getData(id));
    }
  }

  // Clear all callees to default values (or false)
  static ClearAll() {
    Settings.map.saveData = {};
    Settings.commit();

    for (const id of this._saveListeners.getEventIds()) {
      this._saveListeners.fire(id, this._saveListeners.getDefaultData(id));
    }
  }

  //-----------------------------------------------------------------------------------------------
  // Read array data loaded from Suprworld UE5 save file and call any listeners
  // to filter the data and save to settiings
  static _processLoadedArray_sw(arrayData) {
    this.ClearAll();

    const saveDecoder = new UE5SaveDecoder(arrayData, this._outerHandlerIds);
    saveDecoder.area = 'Supraworld';
    while (saveDecoder.nextOuterString()) {
      saveDecoder.handlerId = saveDecoder.match;
      this.callDecoderHandler(saveDecoder);
    }

    Settings.commit();
    for (const id in Settings.map.saveData) {
      this.callListener(id, Settings.map.saveData[id]);
    }
  }

  // Read array data loaded from Suprworld UE4 save file and call any listeners
  // to filter the data and save to settiings
  static _processLoadedArray_sl(arrayData) {
    this.ClearAll();

    const loadedSave = new UESaveObject(arrayData);

    for (const o of loadedSave.Properties) {
      // Skip things we don't knoww how to deal with
      if (
        !o.type ||
        !o.name ||
        o.name == 'None' ||
        o.name == 'EOF' ||
        o.type == 'ObjectPropetty' || // Only player music uses this so skip it
        (o.type == 'ArrayProperty' && o.value.innerType && o.value.innerType == 'StructProperty') ||
        (o.type == 'MapProperty' && (this.mapId != 'siu' || o.name != 'ActorSaveData'))
      ) {
        continue;
      }

      if (o.name == 'ActorSaveData') {
        // This is for SIU PipeCap's
        const actorSaveData = o.value.innerValue;
        const re_match = new RegExp('(DLC2_[^\\0.:]*)[\\0][\\s\\S]{4}PersistentLevel.([^\\0]*?pipe[^\\0]*)', 'gi');
        let m;
        while ((m = re_match.exec(actorSaveData)) != null) {
          this.callDecoderHandler({ parent: o.name, area: m[1], handlerId: 'PersistentLevel.', postmatch: m[2] });
        }
      } else if (o.type == 'ArrayProperty') {
        // One of 'ThingsToRemove', 'ThingsToActivate', 'ThingsToOpenForever'
        for (let x of o.value.value) {
          // map '/Game/FirstPersonBP/Maps/DLC2_Complete.DLC2_Complete:PersistentLevel.Coin442_41' to 'DLC2_Complete:Coin442_41'
          let area = x.split('/').pop().split('.')[0];
          let name = x.split('.').pop();
          if (name != 'None') {
            name = name.capitalised(); // Shell2_1957 appears as shell2_1957 in the save file

            this.callDecoderHandler({ parent: o.name, area: area, handlerId: 'PersistentLevel.', postmatch: name });
          }
        }
      } else {
        if (o.name == 'Player Position') {
          console.log(o.name);
        }
        // Mostly Player upgrade and other properties
        this.callDecoderHandler({ handlerId: o.name, data: o.value });
      }
    }

    Settings.commit();
    for (const id in Settings.map.saveData) {
      this.callListener(id, Settings.map.saveData[id]);
    }
  }

  // Load save file given by Blob (taken from UI)
  static loadFile(blob, mapId) {
    if (!(blob instanceof Blob)) {
      return;
    }
    if (mapId) {
      this.mapId = mapId;
    }

    const reader = new FileReader();

    reader.onloadend = (evt) => {
      try {
        if (this.mapId == 'sw') {
          this._processLoadedArray_sw(evt.target.result);
        } else {
          this._processLoadedArray_sl(evt.target.result);
        }
      } catch {
        alert(`Could not load file, incompatible format: ${blob.name}`);
      }
    };

    reader.onerror = () => {
      alert(`Error reading file, ${reader.error.message}: ${blob.name}`);
    };

    reader.readAsArrayBuffer(blob);
  }

  // Prompt user to select '.sav' file and then load it
  static loadFileDialog(mapId) {
    this.mapId = mapId;
    browser.openLoadFileDialog('.sav', SaveFileSystem.loadFile, SaveFileSystem);
  }
}
