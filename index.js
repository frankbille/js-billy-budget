var axios = require('axios');
var numeral = require('numeral');
var moment = require('moment-timezone');
var GoogleSpreadsheet = require('google-spreadsheet');
var async = require('async');
var https = require('https');
var csvParse = require('csv-parse/lib/sync');

var config = {
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    apiToken: process.env.BILLY_API_TOKEN,
    credentials: process.env.GOOGLE_CREDENTIALS,
    financialYear: process.env.FINANCIAL_YEAR || 2017,
    excludeAccount: function (accountNo) {
        return accountNo >= 62000 && accountNo < 63000;
    }
};

moment.locale('da');

function exportFromBillyToGoogleSpreadsheet() {
    var context = {};

    console.log('Export/Import function started');

    async.series([
        function loadOrganizationDetails(step) {
            axios.get('https://api.billysbilling.com/v2/organization', {
                headers: {
                    'X-Access-Token': config.apiToken
                },
                httpsAgent: new https.Agent({
                    rejectUnauthorized: false
                })
            }).then(function (result) {
                console.log('Organization loaded');

                context.organizationId = result.data.organization.id;

                step();
            });
        },
        function loadBalanceSheet(step) {
            axios.get('https://api.billysbilling.com/v2/organizations/'+context.organizationId+'/balanceList.csv', {
                params: {
                    accessToken: config.apiToken,
                    acceptLanguage: 'da_DK',
                    period: 'fiscalyear:'+context.organizationId+','+config.financialYear
                },
                responseType: 'arraybuffer',
                transformResponse: [function (data) {
                    data = csvParse(data.toString('latin1'), {
                        columns: ['accountNo', 'accountText', 'amount'],
                        "skip_empty_lines": true,
                        from: 2
                    });
                    return data;
                }],
                httpsAgent: new https.Agent({
                    rejectUnauthorized: false
                })
            }).then(function (result) {
                console.log('Balance Sheet loaded');

                context.balanceSheet = result.data;
                context.balanceSheetLookup = {};
                context.balanceSheet.forEach(function(account) {
                    context.balanceSheetLookup[account.accountNo] = account;
                });

                step();
            });
        },
        function loadOpeningBalance(step) {
            axios.get('https://api.billysbilling.com/v2/organizations/'+context.organizationId+'/balanceList.csv', {
                params: {
                    accessToken: config.apiToken,
                    acceptLanguage: 'da_DK',
                    period: 'dates:'+config.financialYear+'-01-01...'+config.financialYear+'-01-01'
                },
                responseType: 'arraybuffer',
                transformResponse: [function (data) {
                    data = csvParse(data.toString('latin1'), {
                        columns: ['accountNo', 'accountText', 'amount'],
                        "skip_empty_lines": true,
                        from: 2
                    });
                    return data;
                }],
                httpsAgent: new https.Agent({
                    rejectUnauthorized: false
                })
            }).then(function (result) {
                console.log('Opening Balance loaded');

                result.data.forEach(function(account) {
                    if (context.balanceSheetLookup[account.accountNo]) {
                        context.balanceSheetLookup[account.accountNo].openingAmount = account.amount;
                    }
                });

                // Filter excluded accounts
                context.balanceSheet = context.balanceSheet.filter(function(account) {
                    return config.excludeAccount(account.accountNo) === false;
                });

                step();
            });
        },
        function loadLatestPostingDate(step) {
            axios.get('https://api.billysbilling.com/v2/transactions', {
                params: {
                    organizationId: context.organizationId,
                    sortProperty: 'entryDate',
                    sortDirection: 'DESC',
                    pageSize: 1,
                    entryDatePeriod: 'fiscalyear:'+context.organizationId+','+config.financialYear
                },
                headers: {
                    'X-Access-Token': config.apiToken
                },
                httpsAgent: new https.Agent({
                    rejectUnauthorized: false
                })
            }).then(function (result) {
                console.log('Latest Postings loaded');

                if (result.data.transactions && result.data.transactions.length > 0) {
                    context.lastPostingDate = moment(result.data.transactions[0].entryDate);
                } else {
                    context.lastPostingDate = null;
                }

                step();
            });
        },
        function loadDocument(step) {
            console.log('Loading document');

            context.doc = new GoogleSpreadsheet(config.spreadsheetId);

            context.doc.useServiceAccountAuth(JSON.parse(config.credentials), step);
        },
        function getInfoAndWorksheets(step) {
            context.doc.getInfo(function (err, info) {
                if (err) {
                    step(err);
                } else {
                    console.log('Sheet loaded');
                    context.sheet = info.worksheets[1];
                    step();
                }
            });
        },
        function updateData(step) {
            context.sheet.getCells({
                'min-row': 2,
                'max-row': 150,
                'min-col': 1,
                'max-col': 4,
                'return-empty': true
            }, function(err, cells) {
                console.log('Cells loaded');

                var cellIndex = 0;
                context.balanceSheet.forEach(function(account) {
                    var accountNoCell = cells[cellIndex];
                    var accountTextCell = cells[cellIndex+1];
                    var amountCell = cells[cellIndex+2];
                    var primoCell = cells[cellIndex+3];

                    accountNoCell.value = account.accountNo;
                    accountTextCell.value = account.accountText;
                    amountCell.value = numeral(account.amount).format('0');
                    primoCell.value = numeral(account.openingAmount).format('0');

                    cellIndex += 4;
                });


                context.sheet.bulkUpdateCells(cells, step);
            });
        },
        function updateMeta(step) {
            context.sheet.getCells({
                'min-row': 4,
                'max-row': 5,
                'min-col': 6,
                'max-col': 6,
                'return-empty': true
            }, function(err, cells) {
                console.log('Last update cells loaded');

                var now = moment().tz('Europe/Copenhagen');
                cells[0].value = now.format('D. MMMM YYYY HH:mm');

                if (context.lastPostingDate) {
                    cells[1].value = context.lastPostingDate.format('D. MMMM YYYY')
                }

                context.sheet.bulkUpdateCells(cells, step);
            });
        }
    ], function (err) {
        if (err) {
            console.error(err);
        }
        console.log('Done');
    });
}

exportFromBillyToGoogleSpreadsheet();