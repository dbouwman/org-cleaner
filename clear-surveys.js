// load seekrets from .env file
require('dotenv').config()
require('isomorphic-fetch');
require('isomorphic-form-data');

const { UserSession } = require('@esri/arcgis-rest-auth');
const { request } = require('@esri/arcgis-rest-request');
const { 
  getSelf,
  getUser ,
  searchItems,
  getItem,
  removeItem
} = require('@esri/arcgis-rest-portal');

const { getProp, cloneObject, maybePush, maybeAdd } = require('@esri/hub-common');

// Setup request options... we use this through all the calls...
let requestOptions = {
  authentication = new UserSession({
    clientId: 'arcgisonline',
    username: process.env.USER,
    password: process.env.PASSWORD,
    portal: `${process.env.PORTAL}/sharing/rest`
  })
};

// call the main function, with the request options...
process(requestOptions);

/**
 * Main function, orchestrates other smaller functions
 */
function process(ro) {
  // get the portalSelf so we have the orgId
  return getSelf(ro)
   .then((portalResponse) => {
      const orgId = portalResponse.id;
      console.log(`Got portal ${orgId} and user: ${portalResponse.user.username}`);
      return removeForms(ro)
   })
   .then((response) => {
     console.log(`Removing orphan services...`);
     // recall what I said? When developing, we break things. Badly.
     // this cleans up S123 Services whos form item no longer exists.
     return removeOrphanServices(ro);
   })
   .then((response) => {
     // also fun,
     return removeEmptySurveyFolders(ro);
   })
  // .then((response) => {
  //    don't use this. very bad things.
  //   return removeServices(ro);
  // })
  .catch((err) => {
    console.info(`Error ${err}`);
  })
}

/**
 * Remove all Form item's owned by this user
 * ok - not all of them, just if they have hubDebug
 * typekeyword...
 */
function removeForms (ro) {
  const owner = ro.authentication.username;
  let query = `owner: '${owner}' AND type: 'Form' AND typekeywords: 'hubDebug'`;
    const form = {
      searchForm: {
       q: query,
       start: 1,
       num: 100
      },
      ...requestOptions
    };
  return searchItems(form)
    .then((response) => {
      return Promise.all(response.results.map((itm) => deleteForm(ro, itm)));
    })
    .catch((err) => {
      console.warn(`Error when removing forms ${err}`);
      return null;
    })
}

/**
 * Actuall Delete the form item...
 */
function deleteForm(ro, formItem) {
  return getServiceItemIds({item: formItem, data:{}})
    .then((ids) => {
      console.info(`Working on form ${formItem.id}, removing items: ${ids.join(', ')}`);
      return Promise.all(ids.map((id) => {
        return deleteItem(id, ro);
      }));
    })
    .then((response) => {
      return response.results.map((itm) => deleteForm(requestOptions, itm))
    })
    .catch((err) => {
      console.error(`Could not delete item ${id}`);
    })
}

/**
 * Form items have various properties connecting them to
 * various services and views, this extracts those ids
 * Note: This will only work for Form's created through Hub
 * Normal forms will need to traverse some relationships
 */
function getServiceItemIds (surveyModel) {
  const ids = [ 'item.id',
    'item.properties.serviceItemId',
    'item.properties.viewItemId', // old
    'item.properties.fieldworkerItemId',
    'item.properties.stakeholderItemId'].reduce((acc, key) => {
    return maybePush(getProp(surveyModel, key), acc);
  }, []);
  // allow for future changes where we make xhrs and use relationships etc
  //
  return Promise.resolve(ids);
};


function removeEmptySurveyFolders(ro) {
  console.log(`Getting user folders...`)
  const userUrl = `${ro.authentication.portal}/content/users/${ro.authentication.username}?f=json&num=1`;
  return request(userUrl, ro)
  .then((user) => {
    console.info(`Got User info with ${user.folders.length} folders`);
    return Promise.all(user.folders.map((f) => {
      console.log(`${f.title} has id ${f.id}`);
      return removeEmptyFolder(f.id, ro);
    }));
  })
  .catch((err) => {
      console.info(`Error ${err}`);
  })
}

function removeEmptyFolder( folderId, ro) {
  return isFolderEmpty(folderId, ro)
    .then((hasContent) => {
      if (!hasContent) {
        return removeFolder(folderId, ro)
      } else {
        return Promise.resolve();
      }
    })
    .catch((err) => {
        console.info(`Error in removeEmptyFolder ${folderId} ${err}`);
    });

}

function removeFolder(folderId, ro) {
  console.info(`Removing folder ${folderId}`);
  const url = `${ro.authentication.portal}/content/users/${ro.authentication.username}/${folderId}/delete?f=json`;
  return request(url, ro)
    .catch((err) => {
        console.info(`Error in removeFolder ${folderId} ${err}`);
    });
}

function isFolderEmpty(folderId, ro) {
  return getFolderContent(folderId, ro)
    .then((items) => {
      if (items.length) {
        console.info(`Folder ${folderId} as ${items.length} items.`);
        return true;
      } else {
        console.info(`Folder ${folderId} is Empty.`);
        return false;
      }
    })
    .catch((err) => {
      console.warn(`Error checking content for folder ${folderId}, assuming it has content...`);
      return Promise.resolve(true);
    })
}

function getFolderContent (folderId, ro) {
  console.info(`Getting content for folder ${folderId}`);
  const url = `${ro.authentication.portal}/content/users/${ro.authentication.username}/${folderId}?f=json`;
  return request(url, ro)
    .then((response) => {
      return response.items;
    })
    .catch((err) => {
        console.info(`Error ${err}`);
    });
}
/**
 * Locate survey123* services, crack the name, see if the form exists
 * if not, delete it
 */
function removeOrphanServices (ro) {
  const owner = ro.authentication.username;
  let query = `title: 'survey123' owner: '${owner}' AND type: 'Feature Service'`;
    const form = {
      searchForm: {
       q: query,
       start: 1,
       num: 100
      },
      ...requestOptions
    };
  return searchItems(form)
  .then((response) => {
    console.info(`Got ${response.results.length} Survey123 Services...`);
    return Promise.all(response.results.map((itm) => {
      return deleteIfFormDoesNotExist(itm, ro);
    }));

  })
  .catch((err) => {
    console.error(`Error removing orphan services ${err}`);
  })
}

function deleteIfFormDoesNotExist(serviceItem, ro) {
  let formId = serviceItem.title.split('_')[1] || null;
  if (formId) {
    console.info(`Checking for form ${formId} still exists...`);
    return doesItemExist(formId, ro)
    .then((exists) => {
      if (exists) {
        console.info(`Form exists for ${serviceItem.title}, not removing...`);
        return Promise.resolve();
      } else {
        console.info(`>>> Form DOES NOT exist for ${serviceItem.title}, removing service...`);
        return deleteItem(serviceItem.id, ro);
        // return Promise.resolve();
      }
    })
  } else {
    console.info(`Service ${serviceItem.title} can not be split into a form id... leaving...`);
    return Promise.resolve()
  }
}

function doesItemExist(itemId, ro) {
  return getItem({id: itemId,authentication: ro.authentication })
  .then((response) => {
    if (!response.error) {
      return true;
    } else {
      return false;
    }
  })
  .catch((err) => {
    if (err.code === 'CONT_0001') {
      return false;
    } else {
      return true
    }
  })
}



/**
 * Remove all S123 Services
 * Total destruction. Run. Do not use this.
 */
function removeServices(ro) {
  const owner = ro.authentication.username;
  let query = `title: 'survey123_' owner: '${owner}' AND type: 'Feature Service'`;
    const form = {
      searchForm: {
       q: query,
       start: 1,
       num: 100
      },
      ...requestOptions
    };
  return searchItems(form)
    .then((response) => {
      console.info(`Processing ${response.results.length} Services...`)
      return Promise.all(response.results.map((itm) => {
        console.info(`Removing ${itm.title}...`);
        return deleteItem(itm.id, ro);
      }));
    })
}

/**
 * Generic item Delete fn w/ extra logging.
 */
function deleteItem(id, ro) {
  return removeItem({id, authentication: ro.authentication})
  .then((resp) => {
    if (resp.success) {
      console.log(`Removed item ${id}`);
    } else {
      console.log(`Failed to remove item ${id} because ${resp.message}`);
    }
  })
  .catch((err) => {
    console.warn(`Could not delete item ${id} with err: ${err}`);
    return Promise.resolve();
  })
}
