Feature: Login via UI
  As a registered user
  I want to sign in through the web interface
  So that I can access the platform

  Background:
    Given the frontend is reachable

  @ui @ui-login
  Scenario: Successful login with valid credentials
    Given I open the login page
    When I navigate to the email login form
    And I fill in the email "user@teros.ai"
    And I fill in the password "userpass"
    And I click the sign in button
    Then I should be redirected to the workspace

  @ui @ui-login
  Scenario: Failed login with wrong password
    Given I open the login page
    When I navigate to the email login form
    And I fill in the email "user@teros.ai"
    And I fill in the password "wrongpassword"
    And I click the sign in button
    Then I should see a login error message

  @ui @ui-login
  Scenario: Failed login with unknown email
    Given I open the login page
    When I navigate to the email login form
    And I fill in the email "nobody@teros.ai"
    And I fill in the password "somepassword"
    And I click the sign in button
    Then I should see a login error message
