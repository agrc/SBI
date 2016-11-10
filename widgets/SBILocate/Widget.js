define([
    './data',

    'dojo/_base/declare',
    'dojo/_base/Color',
    'dojo/_base/lang',
    'dojo/_base/array',

    'dojo/dom-class',

    'dojo/query',
    'dojo/on',
    'dojo/string',

    'esri/symbols/SimpleMarkerSymbol',
    'esri/symbols/SimpleFillSymbol',
    'esri/symbols/SimpleLineSymbol',

    'esri/geometry/Point',
    'esri/geometry/scaleUtils',

    'esri/graphic',
    'esri/request',
    'esri/SpatialReference',

    'jimu/BaseWidget'
], function (
    data,

    declare,
    Color,
    lang,
    array,

    domClass,

    query,
    on,
    dojoString,

    SimpleMarkerSymbol,
    SimpleFillSymbol,
    SimpleLineSymbol,

    Point,
    scaleUtils,

    Graphic,
    esriRequest,
    SpatialReference,

    BaseWidget
) {
    return declare([BaseWidget], {
        baseClass: 'jimu-widget-sbi-locate',
        map: null,
        title: 'Find Street Address',
        symbol: null,
        symbolFill: null,
        exhausted: false,
        graphicsLayer: null,
        _graphic: null,
        zoomLevel: 12,
        apiKey: null,
        wkid: null,
        geocode_url_template: '//api.mapserv.utah.gov/api/v1/Geocode/{street}/{zone}',
        search_url_template: '//api.mapserv.utah.gov/api/v1/Search/{featureClass}/shape@',

        // inline: Boolean (optional)
        //      Controls if form is inline or normal (default) layout
        inline: null,

        postMixInProperties: function () {
            // summary:
            //      postMixin properties like symbol and graphics layer
            // description:
            //      decide whether to use default graphics layer and symbol
            // tags:
            //      public
            console.info('SBILocate::postMixInProperties', arguments);

            // default to use the map's graphics layer if none was passed in
            if (!this.graphicsLayer && !! this.map) {
                // handle race condition
                if (this.map.loaded) {
                    this.graphicsLayer = this.map.graphics;
                } else {
                    this.connect(this.map, 'onLoad', function () {
                        this.graphicsLayer = this.map.graphics;
                    });
                }
            }

            // create symbol if none was provided in options
            this.symbol = new SimpleMarkerSymbol();
            this.symbol.setStyle(SimpleMarkerSymbol.STYLE_DIAMOND);
            this.symbol.setColor(new Color([255, 0, 0, 0.5]));

            var line = new SimpleLineSymbol();
            line.setWidth(3);
            line.setColor(new Color([255, 0, 197, 1]));
            line.setStyle(SimpleLineSymbol.STYLE_DASH);

            this.symbolFill = new SimpleFillSymbol();
            this.symbolFill.setOutline(line);
            this.symbolFill.setStyle(SimpleFillSymbol.STYLE_NULL);

            this.wkid = this.map.spatialReference.wkid;
            this.apiKey = this.config.apikey;
        },

        postCreate: function () {
            console.info('SBILocate::postCreate', arguments);

            this.form.onsubmit = function () {
                return false;
            };

            if (this.inline) {
                domClass.add(this.form, 'form-inline');
            }

            on(this.btnFind, 'click', lang.hitch(this, 'firstTry'));
        },

        firstTry: function () {
            // summary:
            //      Geocodes the address if the text boxes validate.
            console.info('SBILocate::firstTry', arguments);

            if (!this._validate()) {
                this._done();
                return false;
            }

            if (this.map && this._graphic) {
                if (Object.prototype.toString.call(this._graphic) === '[object Array]') {
                    array.forEach(this._graphic, function removeGraphics(g) {
                        this.graphicsLayer.remove(g);
                    }, this);
                }

                this.graphicsLayer.remove(this._graphic);
            }

            var address = this.txtAddress.value;
            var zone = this.txtZone.value;

            if (this.request) {
                this.request.cancel('duplicate in flight');
                this.request = null;
            }

            this.geocode = {
                street: address,
                zone: zone
            };

            var url = lang.replace(this.geocode_url_template, this.geocode);

            this.exhausted = false;
            this.request = this._invokeWebService(url).then(
                lang.hitch(this, '_onFind'), lang.hitch(this, 'fallback')
            );

            return false;
        },

        fallback: function () {
            // summary:
            //      tries to zoom to zone of geocode if no address was found
            // tags:
            //      private
            console.info('SBILocate::fallback', arguments);

            this.exhausted = true;

            var zone = this.geocode.zone;
            var zipRe = /(^\d{5})-?(\d{4})?$/;
            var featureClass = 'SGID10.LOCATION.AddressSystemQuadrants';
            var query = {};

            if (zipRe.test(zone)) {
                featureClass = 'SGID10.BOUNDARIES.ZipCodes';
                query.predicate = 'ZIP5 = \'' + zone + '\'';
            } else {
                zone = zone.toUpperCase();
                var grids = data.filter(function filterGrids(grid) {
                    return grid.name === zone;
                });

                if (grids.length === 0) {
                    return this._onError();
                }

                if (grids.length === 1) {
                    zone = grids[0].addressSystem;
                } else {
                    zone = grids[0];
                    grids.forEach(function findHighestPriorityGrid(grid) {
                        if (grid.priority > zone.priority) {
                            zone = grid;
                        }
                    });
                }

                query.predicate = 'GRID_NAME = \'' + zone + '\'';
            }

            var url = lang.replace(this.search_url_template, {featureClass: featureClass});

            this.request = this._invokeWebService(url, query).then(
                lang.hitch(this, '_onFind'), lang.hitch(this, '_onError')
            );
        },

        _invokeWebService: function (url, query) {
            // summary:
            //      calls the web service
            // description:
            //      sends the request to the wsut webservice
            // tags:
            //      private
            // returns:
            //     Deferred
            console.info('SBILocate::_invokeWebService', arguments);

            var options = {
                apiKey: this.apiKey,
                spatialReference: this.wkid
            };

            lang.mixin(options, query);

            return esriRequest({
                url: url,
                content: options,
                callbackParamName: 'callback'
            });
        },

        _validate: function () {
            // summary:
            //      validates the widget
            // description:
            //      makes sure the street and zone have valid data
            // tags:
            //      private
            // returns:
            //      bool
            console.info('SBILocate::_validate', arguments);

            var that = this;

            // hide error messages
            query('.form-group', this.domNode).removeClass('has-error');

            return array.every([
                this.txtAddress,
                this.txtZone
            ], function (tb) {
                return that._isValid(tb);
            });
        },

        _isValid: function (textBox) {
            // summary:
            //      validates that there are values in the textbox
            // textBox: TextBox Element
            console.log('SBILocate::_isValid', arguments);

            var valid = dojoString.trim(textBox.value).length > 0;

            if (!valid) {
                domClass.add(textBox.parentElement, 'has-error');
            }

            return valid;
        },

        _onFind: function (response) {
            // summary:
            //      handles a successful geocode
            // description:
            //      zooms the map if there is one. publishes the result
            // tags:
            //      private
            console.info('SBILocate::_onFind', arguments);

            this.request = null;

            if (response.status === 200) {
                if (this.map) {
                    // we found an address system
                    if (Object.prototype.toString.call(response.result) === '[object Array]') {
                        this._graphic = array.map(response.result,
                            function convertGeometryToGraphic(geometry) {
                                return new Graphic(geometry);
                            }, this
                        );

                        this._zoomToMultipleFeatures(this._graphic);

                        array.forEach(this._graphic, function (g) {
                            g.setSymbol(this.symbolFill);
                            this.graphicsLayer.add(g);
                        }, this);
                    } else {
                        var point = new Point(
                            response.result.location.x,
                            response.result.location.y,
                            new SpatialReference({
                                wkid: this.wkid
                            })
                        );

                        if (this.map.getLevel() > -1) {
                            this.map.centerAndZoom(point, this.zoomLevel);
                        } else {
                            var scale = scaleUtils.getScale(this.map.extent,
                                                            this.map.width,
                                                            this.wkid);
                            scale = scale / this.zoomLevel;
                            this.map.centerAndZoom(point, scale);
                        }

                        this._graphic = new Graphic(point, this.symbol, response.result);
                        this.graphicsLayer.add(this._graphic);
                    }
                }
            } else if (this.exhausted) {
                return this._onError();
            } else {
                this.fallback();
            }
        },

        _onError: function () {
            // summary:
            //      handles script io geocoding error
            // description:
            //      publishes error
            // tags:
            //      private
            // returns:
            //
            console.info('SBILocate::_onError', arguments);

            domClass.add(this.errorMsg.parentElement, 'has-error');
        },

        _zoomToMultipleFeatures: function (features) {
            // summary:
            //      Creates a multi point from features and zooms to that.
            // features: Object[]
            //      Array of features that you want to zoom to.
            // tags:
            //      private
            console.info('SBILocate:_zoomToMultipleFeatures', arguments);

            function unionExtents() {
                var extent;
                array.forEach(features, function (f) {
                    if (!extent) {
                        extent = f.geometry.getExtent();
                    } else {
                        extent = extent.union(f.geometry.getExtent());
                    }
                });
                return extent;
            }

            var extent = unionExtents();

            this.map.setExtent(extent, true);
        }
    });
});
