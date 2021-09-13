import _ from 'lodash';
import uuid from 'uuid';
import inquirer from 'inquirer';
import { merge } from '../service-utils/resourceUtils';
import { DataSourceIntendedUse, PlaceIndexParameters } from '../service-utils/placeIndexParams';
import { apiDocs, ServiceName } from '../service-utils/constants';
import { $TSContext } from 'amplify-cli-core';
import { getCurrentPlaceIndexParameters } from '../service-utils/placeIndexUtils';
import { getGeoServiceMeta, updateDefaultResource, geoServiceExists, getGeoPricingPlan, checkGeoResourceExists } from '../service-utils/resourceUtils';
import { resourceAccessWalkthrough, pricingPlanWalkthrough, dataProviderWalkthrough } from './resourceWalkthrough';
import { DataProvider, PricingPlan } from '../service-utils/resourceParams';
import { printer, formatter } from 'amplify-prompts';

/**
 * Starting point for CLI walkthrough that creates a place index resource
 * @param context The Amplify Context object
 * @param parameters The configurations of the place index Resource
 */
export const createPlaceIndexWalkthrough = async (
  context: $TSContext,
  parameters: Partial<PlaceIndexParameters>
): Promise<Partial<PlaceIndexParameters>> => {
  // get the place index name
  parameters = merge(parameters, await placeIndexNameWalkthrough(context));

  // get the access
  parameters = merge(parameters, await resourceAccessWalkthrough(parameters, ServiceName.PlaceIndex));

  // initiate pricing plan walkthrough if this is the first Map/Place Index added
  if (!(await geoServiceExists(ServiceName.Map)) && !(await geoServiceExists(ServiceName.PlaceIndex))) {
    parameters = merge(parameters, await pricingPlanWalkthrough(context, parameters));
  }

  // optional advanced walkthrough
  parameters = merge(parameters, await placeIndexAdvancedWalkthrough(context, parameters));

  // ask if the place index should be set as a default. Default to true if it's the only place index
  const currentPlaceIndexResources = await getGeoServiceMeta(ServiceName.PlaceIndex);
  if (currentPlaceIndexResources && Object.keys(currentPlaceIndexResources).length > 0) {
    parameters.isDefault = await context.amplify.confirmPrompt(
        'Do you want to set this search index as default? It will be used in Amplify Search API calls if no explicit reference is provided.',
        true
    );
  }
  else {
      parameters.isDefault = true;
  }

  return parameters;
};

export const placeIndexNameWalkthrough = async (context: any): Promise<Partial<PlaceIndexParameters>> => {
    let indexName;
    while(!indexName) {
        const indexNamePrompt = {
            type: 'input',
            name: 'name',
            message: 'Provide a name for the location search index (place index):',
            validate: context.amplify.inputValidation({
                operator: 'regex',
                value: '^[a-zA-Z0-9]+$',
                onErrorMsg: 'You can use the following characters: a-z A-Z 0-9',
                required: true,
            }),
            default: () => {
                const [shortId] = uuid().split('-');
                return `placeindex${shortId}`;
            },
        };
        const indexNameInput = (await inquirer.prompt([indexNamePrompt])).name as string;
        if (await checkGeoResourceExists(indexNameInput)) {
            printer.info(`Location search index ${indexNameInput} already exists. Choose another name.`);
        }
        else indexName = indexNameInput;
    }
    return { name: indexName };
};

export const placeIndexAdvancedWalkthrough = async (context: $TSContext, parameters: Partial<PlaceIndexParameters>): Promise<Partial<PlaceIndexParameters>> => {
    // const includePricingPlan = await geoServiceExists(ServiceName.Map) || await geoServiceExists(ServiceName.PlaceIndex);
    const includePricingPlan = false;
    const currentPricingPlan = parameters.pricingPlan ? parameters.pricingPlan : await getGeoPricingPlan();
    const advancedSettingOptions: string[] = ['Search data provider (default: Esri)'];
    advancedSettingOptions.push('Search result storage location (default: no result storage)');
    if (includePricingPlan) {
        advancedSettingOptions.push(`Search pricing plan (current: ${currentPricingPlan})`);
    }
    printer.info('Available advanced settings:');
    formatter.list(advancedSettingOptions);
    printer.blankLine();

    if(await context.amplify.confirmPrompt('Do you want to configure advanced settings?', false)) {
        // get the place index data provider
        parameters = merge(parameters, await dataProviderWalkthrough(parameters, ServiceName.PlaceIndex));

        if (includePricingPlan) {
            // get the pricing plan
            parameters = merge(parameters, await pricingPlanWalkthrough(context, parameters));
        }
        else {
            parameters.pricingPlan = currentPricingPlan;
        }

        // get the place index data storage option if the pricing plan is RequestBasedUsage
        if (parameters.pricingPlan === PricingPlan.RequestBasedUsage) {
          parameters = merge(parameters, await placeIndexDataStorageWalkthrough(context, parameters));
        }
        else {
          parameters.dataSourceIntendedUse = DataSourceIntendedUse.SingleUse;
        }
    }
    else {
      parameters.dataProvider = DataProvider.Esri;
      parameters.dataSourceIntendedUse = DataSourceIntendedUse.SingleUse;
      parameters.pricingPlan = currentPricingPlan;
    }

    return parameters;
};

export const placeIndexDataStorageWalkthrough = async (context:$TSContext, parameters: Partial<PlaceIndexParameters>): Promise<Partial<PlaceIndexParameters>> => {
  const areResultsStored = await context.amplify.confirmPrompt(
    `Do you want to cache or store the results of search operations? Refer ${apiDocs.dataSourceUsage}`,
    parameters.dataSourceIntendedUse === DataSourceIntendedUse.Storage
  );
  const intendedUse = areResultsStored ? DataSourceIntendedUse.Storage : DataSourceIntendedUse.SingleUse;
  return { dataSourceIntendedUse: intendedUse };
};

/**
 * Starting point for CLI walkthrough that updates an existing place index resource
 * @param context The Amplify Context object
 * @param parameters The configurations of the place index resource
 * @param resourceToUpdate Name of the place index resource to update
 */
export const updatePlaceIndexWalkthrough = async (
    context: $TSContext,
    parameters: Partial<PlaceIndexParameters>,
    resourceToUpdate?: string
): Promise<Partial<PlaceIndexParameters>> => {
    const indexResources = ((await context.amplify.getResourceStatus()).allResources as any[])
    .filter(resource => resource.service === ServiceName.PlaceIndex)

    if (indexResources.length === 0) {
        printer.error('No search index resource to update. Use "amplify add geo" to create a new search index.');
        return parameters;
    }

    const indexResourceNames = indexResources.map(resource => resource.resourceName);

    if (resourceToUpdate) {
        if (!indexResourceNames.includes(resourceToUpdate)) {
            printer.error(`No search index named ${resourceToUpdate} exists in the project.`);
            return parameters;
        }
    }
    else {
        const resourceQuestion = [
            {
              name: 'resourceName',
              message: 'Select the search index you want to update',
              type: 'list',
              choices: indexResourceNames
            }
        ];
        resourceToUpdate = (await inquirer.prompt(resourceQuestion)).resourceName as string;
    }

    parameters.name = resourceToUpdate;
    parameters = merge(parameters, await getCurrentPlaceIndexParameters(resourceToUpdate));

    // overwrite the parameters based on user input
    parameters.accessType = (await resourceAccessWalkthrough(parameters, ServiceName.PlaceIndex)).accessType;

    const otherIndexResources = indexResourceNames.filter(indexResourceName => indexResourceName != resourceToUpdate);
    // if this is the only place index, default cannot be removed
    if (otherIndexResources.length > 0) {
        const isDefault = await context.amplify.confirmPrompt('Do you want to set this search index as default?', true);
        // If a default place index is updated, ask for new default
        if (parameters.isDefault && !isDefault) {
            await updateDefaultPlaceIndexWalkthrough(context, resourceToUpdate, otherIndexResources);
        }
        parameters.isDefault = isDefault;
    }
    else {
        parameters.isDefault = true; // only place index is always the default
    }
    return parameters;
};

/**
 * Walkthrough to choose a different default place index
 * @param context The Amplify Context object
 * @param currentDefault The current default place index name
 * @param availablePlaceIndices The names of available place indices
 * @returns name of the new default place index choosen
 */
export const updateDefaultPlaceIndexWalkthrough = async (
    context: $TSContext,
    currentDefault: string,
    availablePlaceIndices?: string[]
): Promise<string> => {
    if (!availablePlaceIndices) {
      availablePlaceIndices = ((await context.amplify.getResourceStatus()).allResources as any[])
        .filter(resource => resource.service === ServiceName.PlaceIndex)
        .map(resource => resource.resourceName);
    }
    const otherIndexResources = availablePlaceIndices.filter(indexResourceName => indexResourceName != currentDefault);
    if (otherIndexResources?.length > 0) {
        const defaultIndexQuestion = [
            {
                name: 'defaultIndexName',
                message: 'Select the search index you want to set as default:',
                type: 'list',
                choices: otherIndexResources
            }
        ];
        const defaultIndexName = (await inquirer.prompt(defaultIndexQuestion)).defaultIndexName as string;
        await updateDefaultResource(context, ServiceName.PlaceIndex, defaultIndexName);
    }
    return currentDefault;
}